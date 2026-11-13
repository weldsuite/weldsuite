output "kubeconfig" {
  description = "Admin kubeconfig: tofu output -raw kubeconfig > kubeconfig"
  value       = talos_cluster_kubeconfig.cluster.kubeconfig_raw
  sensitive   = true
}

output "talosconfig" {
  description = "talosctl config: tofu output -raw talosconfig > talosconfig"
  value       = data.talos_client_configuration.cluster.talos_config
  sensitive   = true
}

output "api_endpoint" {
  value = local.cluster_endpoint
}

output "ingress_ipv4" {
  description = "Point the A records of app., api., auth., sign., livekit. and turn.<domain> here."
  value       = hcloud_load_balancer.ingress.ipv4
}

output "ingress_ipv6" {
  value = hcloud_load_balancer.ingress.ipv6
}

# livekit. is WeldMeet's signalling (WebSocket) and turn. its TURN over TLS,
# both through Traefik; media goes to the LiveKit nodes' own addresses, which
# LiveKit tells clients itself (no record). mx. is WeldMail's MX (Haraka)
# when mx_node_port is set.
output "dns_records" {
  description = "The records to create at the EU DNS provider (README.md, step 5)."
  value = {
    for name in concat(["app", "api", "auth", "sign", "admin", "grafana", "livekit", "turn"], var.mx_node_port > 0 ? ["mx"] : []) : "${name}.${var.domain}" => {
      A    = hcloud_load_balancer.ingress.ipv4
      AAAA = hcloud_load_balancer.ingress.ipv6
    }
  }
}

output "nodes" {
  value = {
    for key, node in local.nodes : key => {
      location   = node.location
      pool       = node.pool
      livekit    = node.livekit
      private_ip = node.ip
      public_ip  = hcloud_server.node[key].ipv4_address
    }
  }
}

# The mail nodes (mail.tf) and what DNS needs of them (README.md, "Mail"):
# an A record for each name (its PTR is already set), the names as the
# bounce domain's MX, and the addresses in _spf.<domain>.
locals {
  # Every node that sends mail: the dedicated mail nodes (mail_pools) and the
  # cluster nodes that also send a pool's mail (mail_pool_nodes).
  mail_senders = merge(
    {
      for key, node in local.mail_nodes : key => {
        name     = node.rdns
        pool     = node.mail
        location = node.location
        ipv4     = hcloud_primary_ip.mail[key].ip_address
      }
    },
    {
      for pool, key in var.mail_pool_nodes : key => {
        name     = "mail1-${pool}.${var.domain}"
        pool     = pool
        location = local.nodes[key].location
        ipv4     = hcloud_server.node[key].ipv4_address
      }
    },
  )
}

output "mail_nodes" {
  description = "Each node that sends mail (mail_pools and mail_pool_nodes): pool, location, public IPv4 and the name its PTR (and the MTA's EHLO) carries."
  value       = local.mail_senders
}

output "mail_dns_records" {
  description = "The mail records to create at the EU DNS provider (README.md, \"Mail\"). Empty without mail_pools and mail_pool_nodes."
  value = length(local.mail_senders) == 0 ? {} : merge(
    { for key, node in local.mail_senders : node.name => { A = node.ipv4 } },
    {
      "_spf.${var.domain}" = {
        TXT = "v=spf1 ${join(" ", [for key in sort(keys(local.mail_senders)) : "ip4:${local.mail_senders[key].ipv4}"])} -all"
      }
    },
  )
}
