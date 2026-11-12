#!/usr/bin/env bash
# Give an IPv4-less member a working IPv4 egress through the mesh hub.
#
# A member can be IPv6-only (the provider hands out a global /128 and a private
# 192.168.x address with no public IPv4). The DeepSeek API is IPv4-only, so such
# a member cannot run an agent at all: every request dies in the transport with
# "DeepSeek Messages transport failed".
#
# The fix has two halves, and both are needed:
#
#   hub     enable forwarding and NAT for the member's tunnel address
#   member  send 0.0.0.0/0 into the tunnel and take a default route via the hub
#
# Both halves are installed as a oneshot systemd unit so they survive a reboot.
#
# Usage:
#   egress-via-hub.sh hub    [member-ip ...]   # run on the hub (10.66.66.1)
#   egress-via-hub.sh member                    # run on the member that needs it
#   egress-via-hub.sh status                    # either side
#
# `--remove` uninstalls the unit again.
set -euo pipefail

HUB_IP="${DSH_MESH_HUB_IP:-10.66.66.1}"
WG_IF="${DSH_MESH_WG_IF:-dshwg0}"
UNIT=/etc/systemd/system/dsh-mesh-egress.service
ACTION="install"

args=()
for arg in "$@"; do
  case "$arg" in
    --remove) ACTION="remove" ;;
    *) args+=("$arg") ;;
  esac
done
role="${args[0]:-status}"
shift || true

say() { printf '%s\n' "$*" >&2; }

if [ "$ACTION" = "remove" ]; then
  systemctl disable --now dsh-mesh-egress.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  say "removed $UNIT; existing routes and NAT rules stay until the next reboot"
  exit 0
fi

case "$role" in
  hub)
    members=("$@")
    if [ "${#members[@]}" -eq 0 ]; then
      say "usage: $0 hub <member-ip> [member-ip ...]"
      exit 2
    fi
    sources=""
    for ip in "${members[@]}"; do
      sources+=" -s ${ip}/32"
    done
    cat >"$UNIT" <<EOF
[Unit]
Description=dsh-mesh: IPv4 forwarding and NAT for members without their own egress
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'sysctl -q -w net.ipv4.ip_forward=1; iptables -t nat -C POSTROUTING${sources} -o %i -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING${sources} -o %i -j MASQUERADE'
ExecStop=/bin/sh -c 'iptables -t nat -D POSTROUTING${sources} -o %i -j MASQUERADE 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF
    # %i is the WAN interface name: fill it in from the default route so the
    # unit does not have to guess between eth0/ens5/enp0s5.
    wan="$(ip -4 route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
    if [ -z "$wan" ]; then say "cannot determine the WAN interface"; exit 1; fi
    sed -i "s| -o %i | -o ${wan} |g" "$UNIT"
    sysctl -q -w net.ipv4.ip_forward=1
    sh -c "iptables -t nat -C POSTROUTING${sources} -o ${wan} -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING${sources} -o ${wan} -j MASQUERADE"
    systemctl daemon-reload
    systemctl enable --now dsh-mesh-egress.service >/dev/null
    say "hub now forwards and MASQUERADEs ${members[*]} out of ${wan}"
    iptables -t nat -S POSTROUTING | grep MASQUERADE || true
    ;;
  member)
    if [ ! -f "/etc/wireguard/${WG_IF}.conf" ]; then say "missing /etc/wireguard/${WG_IF}.conf"; exit 1; fi
    hub_key="$(awk -F' = ' '/^PublicKey/ { print $2; exit }' "/etc/wireguard/${WG_IF}.conf")"
    if [ -z "$hub_key" ]; then say "cannot read the hub public key from the tunnel config"; exit 1; fi
    cat >"$UNIT" <<EOF
[Unit]
Description=dsh-mesh: route IPv4 egress through the hub (${HUB_IP})
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
# 0.0.0.0/0 has to be in the peer's AllowedIPs or the tunnel silently drops
# every packet that the default route sends into it.
ExecStart=/bin/sh -c 'wg set ${WG_IF} peer ${hub_key} allowed-ips 0.0.0.0/0; ip route replace default via ${HUB_IP} dev ${WG_IF} metric 50'
ExecStop=/bin/sh -c 'ip route del default via ${HUB_IP} dev ${WG_IF} 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF
    wg set "$WG_IF" peer "$hub_key" allowed-ips 0.0.0.0/0
    ip route replace default via "$HUB_IP" dev "$WG_IF" metric 50
    systemctl daemon-reload
    systemctl enable --now dsh-mesh-egress.service >/dev/null
    say "member now sends IPv4 through ${HUB_IP}"
    ip route show default | head -3
    ;;
  status)
    say "--- ip_forward: $(sysctl -n net.ipv4.ip_forward 2>/dev/null || echo n/a)"
    iptables -t nat -S POSTROUTING 2>/dev/null | grep MASQUERADE || say "--- no MASQUERADE rules"
    say "--- default routes"
    ip route show default || true
    say "--- peer allowed-ips"
    wg show "$WG_IF" allowed-ips 2>/dev/null || true
    systemctl is-enabled dsh-mesh-egress.service 2>/dev/null || say "--- unit not installed"
    ;;
  *)
    say "usage: $0 {hub <member-ip...>|member|status} [--remove]"
    exit 2
    ;;
esac
