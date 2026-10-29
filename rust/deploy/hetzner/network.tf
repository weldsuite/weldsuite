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
