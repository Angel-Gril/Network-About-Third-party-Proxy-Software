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
PUBLISHER=${PUBLISHER:-$(dirname "$RENDERER")/publish-flybird.mjs}
RAW_OUT=${RAW_OUT:-${OUT%.yaml}.raw.yaml}
RAW_METADATA=${RAW_METADATA:-${RAW_OUT}.json}
ENHANCED_OUT=${ENHANCED_OUT:-${OUT%.yaml}.enhanced.yaml}
PUBLIC_DOMAIN=${PUBLIC_DOMAIN:-}
ENTRY_RESOLVER=${ENTRY_RESOLVER:-$(dirname "$RENDERER")/flybird-entries.mjs}
ENTRY_STATE=${ENTRY_STATE:-/var/lib/apex-fetch/entry-addresses.json}
ENTRY_MAX_AGE_SECONDS=${ENTRY_MAX_AGE_SECONDS:-86400}
ENTRY_REQUIRE_IPV4=${ENTRY_REQUIRE_IPV4:-1}
ENTRY_ADDRESS_MODE=${ENTRY_ADDRESS_MODE:-hosts}
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
    [ -r "$PUBLISHER" ] || { log "缺少 FlyBird 发布器 $PUBLISHER"; exit 2; }
    WORKDIR=$(mktemp -d "${OUT}.refresh.XXXXXX") || exit 1
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    raw_out="$WORKDIR/raw.yaml"
    resolved_out="$WORKDIR/resolved.yaml"
    candidate_out="$WORKDIR/distribution.yaml"
    entry_meta="$WORKDIR/entry.json"
    log "开始抓取"
    rc=1
    if ! "$PYTHON" "$FETCHER" --config "$CONF" --out "$raw_out" 2>&1 |
        sed -E 's/(access_key|token|password)=[^[:space:]]+/\1=<redacted>/g' | tee -a "$LOG"; then
        record_failure "FlyBird protocol fetch failed; cached configuration preserved"
        log "抓取失败，保留旧配置"
    else
        if ! "$NODE" "$PUBLISHER" raw --in "$raw_out" --out "$RAW_OUT" --metadata "$RAW_METADATA" 2>&1 | tee -a "$LOG"; then
            record_failure "FlyBird raw configuration could not be saved; published configuration preserved"
            log "原始配置保存失败"
            exit 1
        fi
        log "原始配置已独立保存，开始入口增强"
        resolver_args=(--in "$raw_out" --out "$resolved_out" --state "$ENTRY_STATE" --metadata "$entry_meta" --max-age-seconds "$ENTRY_MAX_AGE_SECONDS" --require-ipv4 "$ENTRY_REQUIRE_IPV4" --address-mode "$ENTRY_ADDRESS_MODE")
        if [ -r "$DOH_CERT" ] && [ -r "$DOH_KEY" ]; then
            resolver_args+=(--cert "$DOH_CERT" --key "$DOH_KEY")
        fi
        entry_rc=1
        if [ -r "$ENTRY_RESOLVER" ]; then
            "$NODE" "$ENTRY_RESOLVER" "${resolver_args[@]}" 2>&1 | tee -a "$LOG"
            entry_status=("${PIPESTATUS[@]}")
            entry_rc=${entry_status[0]}
            if [ "$entry_rc" -eq 0 ] && [ "${entry_status[1]}" -ne 0 ]; then entry_rc=1; fi
        fi
        publication_mode=resolved
        render_source="$resolved_out"
        render_args=()
        if [ "$entry_rc" -ne 0 ]; then
            publication_mode=client-dns
            render_source="$raw_out"
            render_args+=(--client-dns-fallback 1)
            "$PYTHON" - "$entry_meta" "$entry_rc" <<'PYENTRY'
import json, sys
from pathlib import Path
message = "No verified IPv4 entry available" if sys.argv[2] == "4" else "Entry DNS or address validation unavailable"
Path(sys.argv[1]).write_text(json.dumps({"addressMode": "client-dns", "error": message,
    "liveHostCount": 0, "cachedHostCount": 0, "resolvedHostCount": 0}), encoding="utf-8")
PYENTRY
            log "入口增强暂不可用，将发布最新域名配置供客户端解析"
        fi
        private_enabled=0
        if [ "$PUBLISH_PRIVATE_SUBSCRIPTION" = "1" ] || { [ "$PUBLISH_PRIVATE_SUBSCRIPTION" = "auto" ] && [ -d "$PRIVATE_CACHE_DIR" ]; }; then
            private_enabled=1
        fi
        if ! "$NODE" "$RENDERER" --in "$render_source" --out "$candidate_out" --base-url "https://${PUBLIC_DOMAIN}" "${render_args[@]}" 2>&1 | tee -a "$LOG"; then
            record_failure "FlyBird distribution render failed; cached configuration preserved"
            log "渲染失败，保留旧配置"
        elif ! "$NODE" "$PUBLISHER" distribution --in "$candidate_out" --out "$OUT" --mode "$publication_mode" \
            --raw-metadata "$RAW_METADATA" --entry-metadata "$entry_meta" --enhanced-out "$ENHANCED_OUT" \
            --private "$private_enabled" --cache-dir "$PRIVATE_CACHE_DIR" --owner "$CACHE_OWNER" 2>&1 | tee -a "$LOG"; then
            record_failure "FlyBird cache publication failed"
            log "缓存发布失败"
        else
            n=$(count_nodes "$OUT")
            log "完成：$OUT（$n 节点，mode=$publication_mode）"
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
