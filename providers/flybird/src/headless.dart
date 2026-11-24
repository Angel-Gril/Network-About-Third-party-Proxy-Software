// fb_headless.dart — 飞鸟/Apex 7.2.3 无 GUI 协议客户端（Dart，仅 dart:io，无第三方依赖）
//
// 为什么用 Dart：官方客户端就是 Dart/BoringSSL，TLS ClientHello 与 Dart SDK 一致
// （无 ALPN、同一 cipher/extension 顺序），比 Node/curl 更接近官方指纹。
// 编译成单文件二进制后，服务器上不需要装 Flutter/GTK：
//     dart compile exe fb_headless.dart -o fb_headless
//
// 本工具只负责"协议 + 落盘"：
//     loginV2 -> getAccessCredential -> download
// 解密交给 Python 侧（apex_crypto.py，支持 APXS v2 / legacy GCM / CBC / base64 / gzip）。
//
// 用法：
//   dart run fb_headless.dart --base https://fbaxapi.example --email a@b.c --password '***' --out out
//   dart run fb_headless.dart --base https://fbaxapi.example --token <xboard_token> --out out
//   dart run fb_headless.dart --sub https://fbaxsub.example --access-key <KEY> --out out
//   dart run fb_headless.dart --base https://fbaxapi.example --token <t> --path-map map.json --out out

import 'dart:convert';
import 'dart:io';

const kUA = 'ua.net.fbclient.app.apex/v7.2.3';

String _osVersion() {
  final raw = Platform.operatingSystemVersion;
  final m = RegExp(r'\d+\.\d+(\.\d+)?').firstMatch(raw);
  return m?.group(0) ?? '10.0';
}

Map<String, String> defaultPathMap() => {
      '/api/v1/passport/auth/login': '/v2/auth/token',
      '/api/v1/passport/auth/register': '/v2/auth/signup',
      '/api/v1/guest/comm/config': '/v2/site/settings',
      '/api/v1/user/getSubscribe': '/v2/feed/access-token',
      '/api/v1/user/info': '/v2/account/profile',
      '/api/v1/client/subscribe?token=': '/v2/feed/download?access_key=',
    };

Map<String, String> headers({String? token}) {  final h = <String, String>{
    'user-agent': kUA,
    'accept': 'application/json',
    // 官方客户端在 announcements 请求里不带 X-Client-*；登录类请求可自行补充
    'x-client-platform': 'windows',
    'x-client-model': 'PC',
    'x-client-brand': 'Apex',
    'x-client-os-version': _osVersion(),
    'x-client-environment': 'desktop',
    'x-client-security-probe-status': 'passed',
  };
  if (token != null && token.isNotEmpty) h['authorization'] = 'Bearer $token';
  return h;
}

Future<(int, Map<String, String>, List<int>)> http(
  String method,
  String url, {
  String? token,
  Map<String, String>? form,
  Map<String, String>? jsonBody,
  bool insecure = false,
}) async {
  final client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 20)
    ..autoUncompress = false;
  if (insecure) client.badCertificateCallback = (cert, host, port) => true;
  try {
    final req = await client.openUrl(method, Uri.parse(url));
    headers(token: token).forEach(req.headers.set);
    String? body;
    if (form != null) {
      body = form.entries
          .map((e) => '${Uri.encodeQueryComponent(e.key)}=${Uri.encodeQueryComponent(e.value)}')
          .join('&');
      req.headers.contentType = ContentType.parse('application/x-www-form-urlencoded');
    } else if (jsonBody != null) {
      body = jsonEncode(jsonBody);
      req.headers.contentType = ContentType.json;
    }
    if (body != null) req.write(body);
    final resp = await req.close();
    final bytes = await resp.fold<List<int>>(<int>[], (all, chunk) {
      all.addAll(chunk);
      return all;
    });
    final hdrs = <String, String>{};
    resp.headers.forEach((k, v) => hdrs[k] = v.join(', '));
    return (resp.statusCode, hdrs, bytes);
  } finally {
    client.close(force: true);
  }
}

String responseText(List<int> body) => utf8.decode(body, allowMalformed: true);

dynamic unwrap(dynamic j) {
  if (j is Map) {
    for (final k in ['data', 'result', 'payload']) {
      if (j[k] is Map) return {...j, ...(j[k] as Map)};
    }
    return j;
  }
  return <String, dynamic>{};
}

dynamic pick(dynamic m, List<String> names) {
  if (m is! Map) return null;
  for (final n in names) {
    final v = m[n];
    if (v != null && '$v'.isNotEmpty && '$v' != 'null') return v;
  }
  return null;
}

Future<(String, dynamic)> login(String base, Map<String, String> pm, String email, String pwd) async {
  final tail = pm['/api/v1/passport/auth/login'] ?? '/v2/auth/token';
  final urls = <String>['$base$tail', if (tail.contains('/v2/')) '$base/api/v1/passport/auth/login'];
  for (final u in urls) {
    for (final asJson in [false, true]) {
      try {
        final (code, _, body) = await http('POST', u,
            form: asJson ? null : {'email': email, 'password': pwd},
            jsonBody: asJson ? {'email': email, 'password': pwd} : null,
            insecure: false);
        stdout.writeln('[*] login $u (${asJson ? 'json' : 'form'}) -> $code');
        if (code != 200) continue;
        final j = unwrap(jsonDecode(responseText(body)));
        final token = pick(j, ['token', 'access_token', 'auth_data', 'accessToken', 'authData']);
        if (token != null) return ('$token', j);
      } catch (e) {
        stdout.writeln('[!] login $u: $e');
      }
    }
  }
  throw StateError('登录失败');
}

Future<dynamic> getCredential(String base, Map<String, String> pm, String token) async {
  final tail = pm['/api/v1/user/getSubscribe'] ?? '/v2/feed/access-token';
  for (final u in ['$base$tail', '$base/api/v1/user/getSubscribe']) {
    try {
      final (code, _, body) = await http('GET', u, token: token, insecure: false);
      stdout.writeln('[*] access-token $u -> $code');
      if (code != 200) continue;
      final j = unwrap(jsonDecode(responseText(body)));
      stdout.writeln('[*] credential response received (keys=${j is Map ? j.keys.join(',') : 'unknown'})');
      return j;
    } catch (e) {
      stdout.writeln('[!] access-token $u: $e');
    }
  }
  throw StateError('无法获取 access-token');
}

Future<void> main(List<String> args) async {
  final a = <String, String>{};
  for (var i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      final k = args[i].substring(2);
      a[k] = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : '1';
    }
  }
  var base = (a['base'] ?? '').replaceAll(RegExp(r'/+$'), '');
  final sub = (a['sub'] ?? '').replaceAll(RegExp(r'/+$'), '');
  final out = Directory(a['out'] ?? 'out')..createSync(recursive: true);
  final insecure = a['insecure'] == '1';
  var pm = defaultPathMap();
  if (a['path-map'] != null) {
    final m = jsonDecode(File(a['path-map']!).readAsStringSync()) as Map;
    pm = {...pm, ...m.map((k, v) => MapEntry('$k', '$v'))};
  }

  dynamic cred = <String, dynamic>{};
  if (a['access-key'] != null) {
    cred = {'access_key': a['access-key']};
  } else {
    var token = a['token'] ?? '';
    if (token.isEmpty) {
      if (base.isEmpty || a['email'] == null || a['password'] == null) {
        stderr.writeln('需要 --base/--email/--password，或 --token，或 --access-key');
        exit(2);
      }
      final (t, _) = await login(base, pm, a['email']!, a['password']!);
      token = t;
      if (a['save-token'] == '1') File('${out.path}/token.txt').writeAsStringSync(token);
    }
    cred = await getCredential(base, pm, token);
  }

  final key = '${pick(cred, ['access_key', 'accessKey', 'key', 'token']) ?? a['access-key'] ?? ''}';
  final explicit = pick(cred, ['subscribe_url', 'subscribeUrl', 'subscription_url', 'url']);
  String url;
  if (explicit != null) {
    url = '$explicit';
  } else {
    final host = sub.isNotEmpty ? sub : base;
    final tmpl = pm['/api/v1/client/subscribe?token='] ?? '/v2/feed/download?access_key=';
    url = '$host$tmpl${Uri.encodeQueryComponent(key)}';
  }
  final parsedUrl = Uri.parse(url);
  stdout.writeln('[*] download ${parsedUrl.scheme}://${parsedUrl.host}${parsedUrl.path}');
  final (code, hdrs, body) = await http('GET', url, insecure: insecure);
  stdout.writeln('[*] HTTP $code len=${body.length} encoding=${hdrs['content-encoding'] ?? 'identity'}');
  File('${out.path}/raw_body.bin').writeAsBytesSync(body);
  File('${out.path}/response_headers.json').writeAsStringSync(const JsonEncoder.withIndent('  ').convert(hdrs));
  File('${out.path}/credential.json').writeAsStringSync(const JsonEncoder.withIndent('  ').convert(cred));
  stdout.writeln('[*] 已写出 ${out.path}/raw_body.bin, credential.json, response_headers.json');
  stdout.writeln('[*] 下一步: python apex_crypto.py 解密 raw_body.bin');
}
