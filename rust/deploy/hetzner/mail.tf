# The MTA's mail nodes (docs/plans/eu-mail-service.md): dedicated servers,
# one set per IP pool, where `weldsuite mta` runs on the host network and
# sends from the node's own public IPv4. Receivers judge mail by that address
# and its reverse DNS, so both are kept apart from the server: a primary IP
# that stays when the server is rebuilt (an address with a sending history
# is worth keeping), and its PTR mail<n>-<pool>.<domain>, which the MTA's
# EHLO names. Hetzner blocks outbound port 25 on new projects; the unblock
# request is in README.md ("Mail").

locals {
  mail_pool_names = sort(keys(var.mail_pools))

  # mail-<pool>-<n> => node; pool k's nodes at .60+10k ... (variables.tf).
  mail_nodes = merge([
    for k, pool in local.mail_pool_names : {
      for i in range(var.mail_pools[pool].count) : "mail-${pool}-${i + 1}" => {
        location = var.mail_pools[pool].locations[i % length(var.mail_pools[pool].locations)]
        ip       = cidrhost(var.nodes_subnet_cidr, 60 + 10 * k + i)
        type     = var.mail_pools[pool].type
        role     = "worker"
        pool     = "mail"
        livekit  = false
        mail     = pool
        rdns     = "mail${i + 1}-${pool}.${var.domain}"
      }
    }
  ]...)
}

resource "hcloud_primary_ip" "mail" {
  for_each = local.mail_nodes

  name     = "${var.cluster_name}-${each.key}"
  type     = "ipv4"
  location = each.value.location
  # Kept when the server is deleted; `tofu destroy` still removes it.
  auto_delete = false
  labels = merge(local.labels, {
    pool        = "mail"
    "mail-pool" = each.value.mail
  })
}

resource "hcloud_rdns" "mail" {
  for_each = local.mail_nodes

  primary_ip_id = hcloud_primary_ip.mail[each.key].id
  ip_address    = hcloud_primary_ip.mail[each.key].ip_address
  dns_ptr       = each.value.rdns
}

# Pools on existing nodes (mail_pool_nodes): the node's own IPv4 gets the PTR
# mail1-<pool>.<domain>. It is the server's primary IP, so a replaced node
# comes back with a new address and starts its warm-up again.
resource "hcloud_rdns" "node_mail" {
  for_each = var.mail_pool_nodes

  server_id  = hcloud_server.node[each.value].id
  ip_address = hcloud_server.node[each.value].ipv4_address
  dns_ptr    = "mail1-${each.key}.${var.domain}"

  lifecycle {
    precondition {
      condition     = !contains(keys(var.mail_pools), each.key)
      error_message = "mail_pool_nodes: pool ${each.key} is in mail_pools too; put it in one of them."
    }
    # The MTA's DaemonSet tolerates only the mail taint. Control-plane nodes
    # are tainted while the cluster has general workers (talos.tf,
    # allow_scheduling), so the pool would get its address but no MTA.
    precondition {
      condition     = !startswith(each.value, "cp-") || length(local.workers) == 0
      error_message = "mail_pool_nodes: ${each.value} is a control-plane node, which is tainted while worker_count > 0, so the MTA can't run there; use a general worker (worker-N)."
    }
  }
}

resource "hcloud_server" "mail" {
  for_each = local.mail_nodes

  name               = "${var.cluster_name}-${each.key}"
  server_type        = each.value.type
  location           = each.value.location
  image              = data.hcloud_image.talos.id
  placement_group_id = hcloud_placement_group.spread[each.value.location].id
  firewall_ids       = [hcloud_firewall.nodes.id, hcloud_firewall.mail[0].id]
  user_data          = data.talos_machine_configuration.node[each.key].machine_configuration

  labels = merge(local.labels, {
    role        = each.value.role
    pool        = each.value.pool
    "mail-pool" = each.value.mail
  })

  # IPv4 only: the MTA sends over IPv4 (IPv6 sending is not built), and an
  # IPv6 address without a PTR is one more thing a receiver could hold
  # against the node.
  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.mail[each.key].id
    ipv6_enabled = false
  }

  network {
    network_id = hcloud_network.cluster.id
    ip         = each.value.ip
  }

  # As the other nodes (servers.tf): machine config changes go through
  # talosctl, never a rebuild.
  lifecycle {
    ignore_changes = [user_data, image]
  }

  depends_on = [hcloud_network_subnet.nodes]
}

# The bounce MX on the mail nodes, on top of the nodes firewall: DSNs and
# complaint reports for the bounce domain come straight to port 25 on the
# node's public address. Submission (2587) and the MTA's API (8025) listen on
# the private address only and stay closed here (a Hetzner firewall denies
# what it doesn't allow, and never filters the private network).
resource "hcloud_firewall" "mail" {
  count = length(local.mail_nodes) + length(var.mail_pool_nodes) > 0 ? 1 : 0

  name   = "${var.cluster_name}-mail"
  labels = local.labels

  rule {
    description = "SMTP: the MTA's bounce MX"
    direction   = "in"
    protocol    = "tcp"
    port        = "25"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}
