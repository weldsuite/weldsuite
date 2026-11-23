#!/bin/sh
# The metadata guard (metadata-guard.yaml): keeps one rule in this node's
# FORWARD chain that rejects traffic from the pod network to the metadata
# service, for the first second of a pod's life, before kube-router has
# programmed its chain.
#
#   metadata-guard.sh run    insert the rule if it is missing, check again
#                            every GUARD_INTERVAL seconds; never remove it
#   metadata-guard.sh check  exit 0 only when the rule is in place (the
#                            readiness probe)
#
# The pod network is Flannel's FLANNEL_NETWORK, from the subnet.env Flannel
# writes on every node at start. Until it can be read nothing is guarded, the
# pod is not ready, and the log says why.
set -u

subnet_env=/run/flannel/subnet.env
metadata=169.254.169.254/32
comment=weldsuite-metadata-guard
interval="${GUARD_INTERVAL:-15}"
node="${NODE_NAME:-this node}"

# The pod network as a.b.c.d/n, or nothing.
pod_network() {
  [ -r "$subnet_env" ] || return 1
  cidr="$(sed -n 's/^FLANNEL_NETWORK=//p' "$subnet_env" | head -n 1)"
  printf '%s\n' "$cidr" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' || return 1
  printf '%s\n' "$cidr"
}

# The rule, through iptables-nft: the nf_tables backend Talos runs and
# kube-router picks there, called by name so no wrapper guesses. $1 is -C or
# -I, then the position for -I.
rule() {
  op="$1"
  shift
  iptables-nft "$op" FORWARD "$@" -s "$cidr" -d "$metadata" -m comment --comment "$comment" -j REJECT
}

check() {
  if ! cidr="$(pod_network)"; then
    echo "no pod network: FLANNEL_NETWORK is not readable in $subnet_env"
    exit 1
  fi
  if ! rule -C 2>/dev/null; then
    echo "no rule: FORWARD -s $cidr -d $metadata -j REJECT ($comment) is missing"
    exit 1
  fi
}

run() {
  trap 'exit 0' TERM INT
  last=""
  while :; do
    if ! cidr="$(pod_network)"; then
      state="can't read FLANNEL_NETWORK from $subnet_env: nothing is guarded on $node yet"
    elif rule -C 2>/dev/null; then
      state="guarding $node: FORWARD -s $cidr -d $metadata -j REJECT"
    elif error="$(rule -I 1 2>&1)"; then
      # Logged every time: something removed it.
      echo "inserted FORWARD -s $cidr -d $metadata -j REJECT ($comment) on $node"
      state="guarding $node: FORWARD -s $cidr -d $metadata -j REJECT"
    else
      state="can't insert the rule on $node: $error"
    fi
    if [ "$state" != "$last" ]; then
      echo "$state"
      last="$state"
    fi
    sleep "$interval" &
    wait $!
  done
}

case "${1:-}" in
  run) run ;;
  check) check ;;
  *)
    echo "usage: metadata-guard.sh run|check" >&2
    exit 2
    ;;
esac
