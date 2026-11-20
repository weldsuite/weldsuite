output "ipv4" {
  value = hcloud_server.store.ipv4_address
}

output "ipv6" {
  value = hcloud_server.store.ipv6_address
}

output "dns_records" {
  description = "Add these before anything else: Caddy gets the certificate once the name points here."
  value = [
    "${var.hostname}. A ${hcloud_server.store.ipv4_address}",
    "${var.hostname}. AAAA ${hcloud_server.store.ipv6_address}",
  ]
}

output "secret_store_url" {
  description = "The cluster's SECRET_STORE_URL (cluster-settings.yaml)."
  value       = "https://${var.hostname}"
}
