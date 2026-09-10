"""Check Nginx template syntax and credential-URI logging with synthetic traffic."""
import http.client
from pathlib import Path
import shutil
import signal
import socket
import ssl
import subprocess
import tempfile
import time


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def run_variant(root, template, nginx, protected):
    work = root / ('protected' if protected else 'regression-control')
    work.mkdir()
    http_port, tls_port, backend_port = free_port(), free_port(), free_port()
    rendered = template.replace('listen 443 ssl;', f'listen 127.0.0.1:{tls_port} ssl;')
    rendered = rendered.replace('listen [::]:443 ssl;', '')
    rendered = rendered.replace('listen 80;', f'listen 127.0.0.1:{http_port};').replace('listen [::]:80;', '')
    rendered = rendered.replace('127.0.0.1:3100', f'127.0.0.1:{backend_port}')
    substitutions = {'/var/log/nginx/private-subscription.access.log': str(work / 'access.log'),
        '/var/log/nginx/private-subscription.error.log': str(work / 'error.log'),
        '/etc/letsencrypt/live/sub.example.com/fullchain.pem': str(root / 'cert.pem'),
        '/etc/letsencrypt/live/sub.example.com/privkey.pem': str(root / 'key.pem'),
        '/etc/letsencrypt/options-ssl-nginx.conf': str(root / 'tls-options.conf'),
        '/etc/letsencrypt/ssl-dhparams.pem': str(root / 'dh.pem')}
    for old, new in substitutions.items():
        rendered = rendered.replace(old, new)
    if not protected:
        # An isolated control restores request logging, never the real source.
        rendered = rendered.replace('access_log off;', '').replace('error_log /dev/null;', '')
    configuration = work / 'nginx.conf'
    configuration.write_text(f'daemon off;\nmaster_process off;\npid {work}/nginx.pid;\n'
        f'error_log {work}/global-error.log;\nevents {{}}\nhttp {{\naccess_log {work}/global-access.log;\n'
        + rendered + '\n}\n')
    command = [nginx, '-p', str(work), '-c', str(configuration)]
    subprocess.run([*command, '-t'], check=True, capture_output=True)
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    token = 'synthetic-subscription-marker-for-nginx-test'
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                with socket.create_connection(('127.0.0.1', http_port), timeout=0.2):
                    break
            except OSError:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Temporary Nginx did not start')
                time.sleep(0.05)
        path = '/s/' + token + '/leapvpn.yaml'
        connection = http.client.HTTPConnection('127.0.0.1', http_port, timeout=5)
        connection.request('GET', path, headers={'Host': 'sub.example.com'})
        response = connection.getresponse()
        assert response.status == 301
        response.read()
        connection.close()
        connection = http.client.HTTPSConnection('127.0.0.1', tls_port, timeout=5,
                                                  context=ssl._create_unverified_context())
        connection.request('GET', path, headers={'Host': 'sub.example.com'})
        response = connection.getresponse()
        assert response.status == 502, 'The synthetic backend must be unavailable'
        response.read()
        connection.close()
    finally:
        process.send_signal(signal.SIGQUIT)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    found = any(token in file.read_text(errors='replace') for file in work.glob('*.log'))
    assert found is (not protected), 'Credential URI logging did not match the expected boundary'


def main():
    nginx, openssl = shutil.which('nginx'), shutil.which('openssl')
    if not nginx or not openssl:
        raise SystemExit('Install Nginx and OpenSSL to run this Linux integration check')
    project = Path(__file__).resolve().parents[1]
    template = (project / 'vps-service/deploy/nginx-sub.conf').read_text()
    with tempfile.TemporaryDirectory(prefix='subscription-nginx-test-') as directory:
        root = Path(directory)
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=sub.example.com', '-keyout', str(root / 'key.pem'),
                        '-out', str(root / 'cert.pem')], check=True, capture_output=True)
        subprocess.run([openssl, 'dhparam', '-dsaparam', '-out', str(root / 'dh.pem'), '2048'],
                        check=True, capture_output=True, timeout=60)
        (root / 'tls-options.conf').write_text('ssl_protocols TLSv1.2 TLSv1.3;\n')
        run_variant(root, template, nginx, protected=False)
        run_variant(root, template, nginx, protected=True)
    print('Nginx syntax and URI log-redaction checks passed, including a leaking regression control')


if __name__ == '__main__':
    main()
