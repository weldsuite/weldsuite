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
        cert_sans    = compact([hcloud_load_balancer.api.ipv4, local.api_lb_private_ip, var.api_hostname])
        nodes_subnet = var.nodes_subnet_cidr
      }),
    ] : [],
    each.value.pool == "postgres" ? [file("${path.module}/talos/postgres.yaml")] : [],
  )
}

data "talos_client_configuration" "cluster" {
  cluster_name         = var.cluster_name
  client_configuration = talos_machine_secrets.cluster.client_configuration
  endpoints            = [for key in keys(local.control_planes) : hcloud_server.node[key].ipv4_address]
  nodes                = [for key in keys(local.control_planes) : hcloud_server.node[key].ipv4_address]
}

# etcd is bootstrapped once, on the first control-plane node.
resource "talos_machine_bootstrap" "cluster" {
  node                 = hcloud_server.node[local.first_cp].ipv4_address
  client_configuration = talos_machine_secrets.cluster.client_configuration
}

resource "talos_cluster_kubeconfig" "cluster" {
  node                 = hcloud_server.node[local.first_cp].ipv4_address
  client_configuration = talos_machine_secrets.cluster.client_configuration

  depends_on = [talos_machine_bootstrap.cluster]
}
