#!/usr/bin/env bash
# apex-fetch.sh — 飞鸟订阅纯协议抓取（无需官方客户端 / 无需 netns / 不用关 swap）
#
#   apex-fetch.sh run      抓取一次（systemd 调用）
#   apex-fetch.sh status   查看结果
#   apex-fetch.sh test     只验证账号/证书/解密，不落盘
#
# 配置：/etc/apex-fetch/config（600）
set -uo pipefail

CONF=${APEX_CONF:-/etc/apex-fetch/config}
[ -r "$CONF" ] || { echo "缺少配置文件 $CONF" >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONF"

PYTHON=${PYTHON:-python3}
FETCHER=${FETCHER:-/opt/apex/apex_fetch.py}
OUT=${OUT:-/var/lib/apex-fetch/sub.yaml}
LOGDIR=${LOGDIR:-/var/log/apex-fetch}
HOOK_AFTER_PUBLISH=${HOOK_AFTER_PUBLISH:-}
MIN_NODES=${MIN_NODES:-20}
umask 077
NODE=${NODE:-/usr/local/bin/node}
RENDERER=${RENDERER:-/opt/private-subscription/apps/subscription-server/src/render-flybird.mjs}
PUBLIC_DOMAIN=${PUBLIC_DOMAIN:-}
ENTRY_RESOLVER=${ENTRY_RESOLVER:-$(dirname "$RENDERER")/flybird-entries.mjs}
ENTRY_STATE=${ENTRY_STATE:-/var/lib/apex-fetch/entry-addresses.json}
ENTRY_MAX_AGE_SECONDS=${ENTRY_MAX_AGE_SECONDS:-86400}
ENTRY_REQUIRE_IPV4=${ENTRY_REQUIRE_IPV4:-1}
DOH_CERT=${DOH_CERT:-/etc/apex-fetch/certs/doh.crt}
DOH_KEY=${DOH_KEY:-/etc/apex-fetch/certs/doh.key}
CACHE_OWNER=${CACHE_OWNER:-subsvc}
WORKDIR=
PRIVATE_CACHE_DIR=${PRIVATE_CACHE_DIR:-/var/lib/private-subscription/cache}
PUBLISH_PRIVATE_SUBSCRIPTION=${PUBLISH_PRIVATE_SUBSCRIPTION:-auto}

count_nodes() {
    python3 - "$1" <<'PY' 2>/dev/null || echo 0
import sys
try:
    import yaml
except ImportError:
    raise SystemExit(1)
d = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print(len((d or {}).get("proxies") or []))
PY
}

publish_private_subscription() {
    [ "${PUBLISH_PRIVATE_SUBSCRIPTION:-auto}" = "1" ] || {
        [ "$PUBLISH_PRIVATE_SUBSCRIPTION" = "auto" ] && [ -d "$PRIVATE_CACHE_DIR" ] || return 0
    }
    [ -d "$PRIVATE_CACHE_DIR" ] || { log "Private Subscription 缓存目录不存在：$PRIVATE_CACHE_DIR"; return 0; }
    local target="$PRIVATE_CACHE_DIR/flybird.yaml" previous="$PRIVATE_CACHE_DIR/flybird.previous.yaml"
    local metadata="$PRIVATE_CACHE_DIR/flybird.json" tmp_yaml tmp_meta sha count updated changed
    tmp_yaml="$target.apex.tmp"; tmp_meta="$metadata.apex.tmp"
    sha=$(sha256sum "$OUT" | awk '{print $1}')
    count=$(count_nodes "$OUT")
    updated=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ); changed=true
    if [ -f "$target" ] && cmp -s "$OUT" "$target"; then
        changed=false
    elif [ -f "$target" ]; then
        install -o "$CACHE_OWNER" -g "$CACHE_OWNER" -m 0640 "$target" "$previous" || return 1
    fi
    install -o "$CACHE_OWNER" -g "$CACHE_OWNER" -m 0640 "$OUT" "$tmp_yaml" || return 1
    "$PYTHON" - "$1" "$sha" "$count" "$updated" "$changed" > "$tmp_meta" <<'PYMETA' || return 1
import json, sys
from pathlib import Path
entry = json.loads(Path(sys.argv[1]).read_text())
warnings = []
if entry.get("cachedHostCount"):
    warnings.append("Upstream node DNS unavailable; using a matching previously observed entry cache")
if entry.get("ipv6OnlyHostCount"):
    warnings.append("Current entry addresses require client IPv6 connectivity")
print(json.dumps({"schemaVersion": 1, "provider": "flybird", "updatedAt": sys.argv[4],
    "changed": sys.argv[5] == "true", "sha256": sys.argv[2], "proxyCount": int(sys.argv[3]),
    "validatedHostCount": entry.get("liveHostCount", 0),
    "recoveredServerCount": entry.get("cachedServerCount", 0), "delegatedHostCount": 0,
    "entryResolution": entry, "lastWarning": "; ".join(warnings) or None,
    "lastError": None, "source": "apex-pure-protocol"}))
PYMETA
    chown "$CACHE_OWNER:$CACHE_OWNER" "$tmp_meta" || return 1
    chmod 0600 "$tmp_meta" || return 1
    mv -f "$tmp_yaml" "$target" || return 1
    mv -f "$tmp_meta" "$metadata" || return 1
    log "已同步 Private Subscription：$target（$count 节点，changed=$changed）"
}

mkdir -p "$LOGDIR" "$(dirname "$OUT")"
TS=$(date +%Y%m%d-%H%M%S)
LOG=$LOGDIR/$TS.log
ln -sf "$LOG" "$LOGDIR/latest.log"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }

cleanup() {
    trap - EXIT INT TERM
    if [ -n "${WORKDIR:-}" ] && [[ "$WORKDIR" == "${OUT}.refresh."* ]]; then
        rm -rf -- "$WORKDIR"
    fi
}

record_failure() {
    [ "${PUBLISH_PRIVATE_SUBSCRIPTION:-auto}" = "1" ] || {
        [ "$PUBLISH_PRIVATE_SUBSCRIPTION" = "auto" ] && [ -d "$PRIVATE_CACHE_DIR" ] || return 0;
    }
    local module
    module="$(dirname "$RENDERER")/cache.mjs"
    [ -f "$PRIVATE_CACHE_DIR/flybird.json" ] && [ -r "$module" ] || return 0
    "$NODE" --input-type=module - "$module" "$PRIVATE_CACHE_DIR" "$1" <<'JSMETA'
import { pathToFileURL } from 'node:url';
const { recordFailure } = await import(pathToFileURL(process.argv[2]).href);
await recordFailure(process.argv[3], 'flybird', new Error(process.argv[4]));
JSMETA
}

do_run() {
    [ -x "$PYTHON" ] || command -v "$PYTHON" >/dev/null || { log "缺少 python3"; exit 2; }
    [ -f "$FETCHER" ] || { log "缺少 $FETCHER"; exit 2; }

    exec 9>"$LOGDIR/.lock"
    if ! flock -n 9; then
        log "已有实例在运行，退出"
        exit 0
    fi

    [ -n "$PUBLIC_DOMAIN" ] || { log "缺少 PUBLIC_DOMAIN，无法生成分组规则中的 GeoX URL"; exit 2; }
    [ -r "$RENDERER" ] || { log "缺少 FlyBird 渲染器 $RENDERER"; exit 2; }
    [ -x "$NODE" ] || { log "缺少 Node.js 可执行文件 $NODE"; exit 2; }
    [ -r "$ENTRY_RESOLVER" ] || { log "缺少入口解析器 $ENTRY_RESOLVER"; exit 2; }
    WORKDIR=$(mktemp -d "${OUT}.refresh.XXXXXX") || exit 1
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    raw_out="$WORKDIR/raw.yaml"
    resolved_out="$WORKDIR/resolved.yaml"
    entry_meta="$WORKDIR/entry.json"
    log "开始抓取"
    rc=1
    if ! "$PYTHON" "$FETCHER" --config "$CONF" --out "$raw_out" 2>&1 | tee -a "$LOG"; then
        record_failure "FlyBird protocol fetch failed; cached configuration preserved"
        log "抓取失败，保留旧配置"
    else
        resolver_args=(--in "$raw_out" --out "$resolved_out" --state "$ENTRY_STATE" --metadata "$entry_meta" --max-age-seconds "$ENTRY_MAX_AGE_SECONDS" --require-ipv4 "$ENTRY_REQUIRE_IPV4")
        if [ -r "$DOH_CERT" ] && [ -r "$DOH_KEY" ]; then
            resolver_args+=(--cert "$DOH_CERT" --key "$DOH_KEY")
        fi
        "$NODE" "$ENTRY_RESOLVER" "${resolver_args[@]}" 2>&1 | tee -a "$LOG"
        entry_status=("${PIPESTATUS[@]}")
        entry_rc=${entry_status[0]}
        if [ "$entry_rc" -eq 0 ] && [ "${entry_status[1]}" -ne 0 ]; then entry_rc=1; fi
        if [ "$entry_rc" -ne 0 ]; then
            if [ "$entry_rc" -eq 4 ]; then
                record_failure "FlyBird has no validated IPv4 entry; general distribution not replaced"
            else
                record_failure "FlyBird entry DNS failed without a matching recent address cache; cached configuration preserved"
            fi
            log "入口解析失败，保留旧配置"
        elif ! "$NODE" "$RENDERER" --in "$resolved_out" --out "$OUT" --base-url "https://${PUBLIC_DOMAIN}" 2>&1 | tee -a "$LOG"; then
            record_failure "FlyBird distribution render failed; cached configuration preserved"
            log "渲染失败，保留旧配置"
        elif ! publish_private_subscription "$entry_meta"; then
            record_failure "FlyBird cache publication failed"
            log "缓存发布失败"
        else
            n=$(count_nodes "$OUT")
            log "完成：$OUT（$n 节点，入口已解析）"
            rc=0
            if [ -n "$HOOK_AFTER_PUBLISH" ]; then
                sh -c "$HOOK_AFTER_PUBLISH" >>"$LOG" 2>&1 || log "钩子失败（不影响结果）"
            fi
        fi
    fi
    exit $rc
}

do_test() {
    exec 9>"$LOGDIR/.lock"
    flock -n 9 || { echo "已有实例在运行"; exit 0; }
    "$PYTHON" "$FETCHER" --config "$CONF" --test 2>&1 | tee -a "$LOG"
}

do_status() {
    echo "配置文件: $CONF"
    echo "输出文件: $OUT"
    if [ -f "$OUT" ]; then
        echo "节点数  : $(count_nodes "$OUT")"
        echo "更新时间: $(date -r "$OUT" '+%F %T')"
        echo "大小    : $(stat -c%s "$OUT") B"
    else
        echo "节点数  : (无输出)"
    fi
    echo "最近日志: $(readlink -f "$LOGDIR/latest.log" 2>/dev/null)"
    [ -f "$LOGDIR/latest.log" ] && tail -6 "$LOGDIR/latest.log"
    echo "定时器  : $(systemctl is-active apex-fetch.timer 2>/dev/null)"
}

case "${1:-}" in
    run)    do_run ;;
    status) do_status ;;
    test)   do_test ;;
    *) echo "用法: $0 {run|status|test}" >&2; exit 2 ;;
esac
