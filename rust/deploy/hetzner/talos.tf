locals {
  api_endpoint     = var.api_hostname != "" ? var.api_hostname : hcloud_load_balancer.api.ipv4
  cluster_endpoint = "https://${local.api_endpoint}:6443"
  first_cp         = "cp-1"
}

resource "talos_machine_secrets" "cluster" {
  talos_version = var.talos_version
}

# One machine config per node: the role's base config plus the node's
# location as its topology zone, so CloudNativePG, NATS and the API spread
# across locations (topology.kubernetes.io/zone), and the pool labels and
# taints.
data "talos_machine_configuration" "node" {
  for_each = local.nodes

  cluster_name       = var.cluster_name
  cluster_endpoint   = local.cluster_endpoint
  machine_type       = each.value.role
  machine_secrets    = talos_machine_secrets.cluster.machine_secrets
  talos_version      = var.talos_version
  kubernetes_version = var.kubernetes_version != "" ? var.kubernetes_version : null
  docs               = false
  examples           = false

  config_patches = concat(
    [
      templatefile("${path.module}/talos/common.yaml.tftpl", {
        hostname     = "${var.cluster_name}-${each.key}"
        location     = each.value.location
        region       = var.network_zone
        pool         = each.value.pool
        nodes_subnet = var.nodes_subnet_cidr
        pod_cidr     = var.pod_cidr
        service_cidr = var.service_cidr
      }),
    ],
    each.value.role == "controlplane" ? [
      templatefile("${path.module}/talos/controlplane.yaml.tftpl", {
        cert_sans        = compact([hcloud_load_balancer.api.ipv4, local.api_lb_private_ip, var.api_hostname])
        nodes_subnet     = var.nodes_subnet_cidr
        allow_scheduling = length(local.workers) == 0
      }),
    ] : [],
    each.value.pool == "postgres" ? [file("${path.module}/talos/postgres.yaml")] : [],
  )
}

# talosctl, the bootstrap and the kubeconfig go through the API load balancer,
# which reaches the control plane over the private network; nodes are named by
# their private address. A node's own public address only answers
# admin_cidrs, and the Hetzner firewall can see an operator's traffic from
# another address than the operator does (the first apply's bootstrap timed
# out that way).
data "talos_client_configuration" "cluster" {
  cluster_name         = var.cluster_name
  client_configuration = talos_machine_secrets.cluster.client_configuration
  endpoints            = [local.api_endpoint]
  nodes                = [for node in local.control_planes : node.ip]
}

# etcd is bootstrapped once, on the first control-plane node.
resource "talos_machine_bootstrap" "cluster" {
  endpoint             = local.api_endpoint
  node                 = local.control_planes[local.first_cp].ip
  client_configuration = talos_machine_secrets.cluster.client_configuration

  depends_on = [hcloud_load_balancer_target.api]
}

resource "talos_cluster_kubeconfig" "cluster" {
  endpoint             = local.api_endpoint
  node                 = local.control_planes[local.first_cp].ip
  client_configuration = talos_machine_secrets.cluster.client_configuration

  depends_on = [talos_machine_bootstrap.cluster]
}
