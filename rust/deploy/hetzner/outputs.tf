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
# LiveKit tells clients itself (no record).
output "dns_records" {
  description = "The records to create at the EU DNS provider (README.md, step 5)."
  value = {
    for name in ["app", "api", "auth", "sign", "admin", "livekit", "turn"] : "${name}.${var.domain}" => {
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
