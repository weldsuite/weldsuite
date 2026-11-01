# The Talos snapshot uploaded by scripts/upload-talos-image.sh (Hetzner has
# no Talos image of its own).
data "hcloud_image" "talos" {
  with_selector     = "${var.talos_image_selector},talos_version=${var.talos_version}"
  with_architecture = "x86"
  most_recent       = true
}

locals {
  # Fixed private addresses: 10-19 control plane, 20-39 workers, 40-59 Postgres.
  control_planes = {
    for i, location in var.control_plane_locations : "cp-${i + 1}" => {
      location = location
      ip       = cidrhost(var.nodes_subnet_cidr, 10 + i)
      type     = var.control_plane_type
      role     = "controlplane"
      pool     = "control-plane"
    }
  }
  workers = {
    for i in range(var.worker_count) : "worker-${i + 1}" => {
      location = var.worker_locations[i % length(var.worker_locations)]
      ip       = cidrhost(var.nodes_subnet_cidr, 20 + i)
      type     = var.worker_type
      role     = "worker"
      pool     = "general"
    }
  }
  postgres = {
    for i, location in var.postgres_locations : "pg-${i + 1}" => {
      location = location
      ip       = cidrhost(var.nodes_subnet_cidr, 40 + i)
      type     = var.postgres_type
      role     = "worker"
      pool     = "postgres"
    }
  }
  nodes = merge(local.control_planes, local.workers, local.postgres)
}

resource "hcloud_server" "node" {
  for_each = local.nodes

  name               = "${var.cluster_name}-${each.key}"
  server_type        = each.value.type
  location           = each.value.location
  image              = data.hcloud_image.talos.id
  placement_group_id = hcloud_placement_group.spread[each.value.location].id
  firewall_ids       = [hcloud_firewall.nodes.id]
  # Talos reads its machine config from the Hetzner metadata service.
  user_data = data.talos_machine_configuration.node[each.key].machine_configuration

  labels = merge(local.labels, {
    role = each.value.role
    pool = each.value.pool
  })

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  network {
    network_id = hcloud_network.cluster.id
    ip         = each.value.ip
  }

  # A changed machine config is applied with talosctl (README.md), never by
  # replacing a running node; a new Talos release is an upgrade, not a rebuild.
  lifecycle {
    ignore_changes = [user_data, image]
  }

  depends_on = [hcloud_network_subnet.nodes]
}
