locals {
  labels = merge(var.labels, {
    cluster    = var.cluster_name
    managed-by = "opentofu"
  })

  # Every location the cluster uses: one spread placement group each, so no
  # two nodes of a location share a physical host (or, mostly, a rack).
  locations = distinct(concat(var.control_plane_locations, var.worker_locations, var.postgres_locations))
}

resource "hcloud_network" "cluster" {
  name     = var.cluster_name
  ip_range = var.network_cidr
  labels   = local.labels
}

resource "hcloud_network_subnet" "nodes" {
  network_id   = hcloud_network.cluster.id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = var.nodes_subnet_cidr
}

resource "hcloud_placement_group" "spread" {
  for_each = toset(local.locations)

  name   = "${var.cluster_name}-${each.key}"
  type   = "spread"
  labels = local.labels
}

# The public interface only: traffic on the private network is not filtered
# by Hetzner firewalls. Ingress arrives through the load balancer over the
# private network, so no public HTTP port is open on any node.
resource "hcloud_firewall" "nodes" {
  name   = var.cluster_name
  labels = local.labels

  rule {
    description = "Kubernetes API"
    direction   = "in"
    protocol    = "tcp"
    port        = "6443"
    source_ips  = var.admin_cidrs
  }

  rule {
    description = "Talos API"
    direction   = "in"
    protocol    = "tcp"
    port        = "50000"
    source_ips  = var.admin_cidrs
  }

  rule {
    description = "ICMP"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

# The LiveKit workers' media ports, on top of the firewall above. LiveKit
# runs on their host network (rust/deploy/flux/infrastructure/video) and
# hands clients the node's own public address, so these come straight in,
# not through a load balancer. The ports match its values/livekit.yaml.
# TURN over TLS needs nothing here: clients reach it on 443 through the
# ingress load balancer and Traefik. LiveKit's HTTP port (7880) and its
# plain TURN port behind Traefik (5349) stay closed on the public side.
resource "hcloud_firewall" "livekit" {
  name   = "${var.cluster_name}-livekit"
  labels = local.labels

  rule {
    description = "WebRTC media (ICE over UDP, one muxed port)"
    direction   = "in"
    protocol    = "udp"
    port        = "7882"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "WebRTC over TCP, when a network blocks UDP"
    direction   = "in"
    protocol    = "tcp"
    port        = "7881"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "TURN over UDP (also the clients' STUN)"
    direction   = "in"
    protocol    = "udp"
    port        = "3478"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}
