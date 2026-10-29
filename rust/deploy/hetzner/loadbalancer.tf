# Two load balancers in the first location, both reaching nodes over the
# private network: one for the Kubernetes and Talos APIs (control plane), one
# for HTTP(S) to the ingress controller on every general worker (on the
# control plane when there are none). A location outage takes a load balancer
# with it; DNS failover to the second location (design doc, "Edge") is the
# documented next step, not built here.

locals {
  api_lb_private_ip     = cidrhost(var.nodes_subnet_cidr, 2)
  ingress_lb_private_ip = cidrhost(var.nodes_subnet_cidr, 3)
  ingress_targets       = length(local.workers) > 0 ? local.workers : local.control_planes
}

resource "hcloud_load_balancer" "api" {
  name               = "${var.cluster_name}-api"
  load_balancer_type = var.api_lb_type
  location           = var.control_plane_locations[0]
  labels             = local.labels
}

resource "hcloud_load_balancer_network" "api" {
  load_balancer_id = hcloud_load_balancer.api.id
  network_id       = hcloud_network.cluster.id
  ip               = local.api_lb_private_ip

  depends_on = [hcloud_network_subnet.nodes]
}

resource "hcloud_load_balancer_target" "api" {
  for_each = local.control_planes

  load_balancer_id = hcloud_load_balancer.api.id
  type             = "server"
  server_id        = hcloud_server.node[each.key].id
  use_private_ip   = true

  depends_on = [hcloud_load_balancer_network.api]
}

resource "hcloud_load_balancer_service" "kubernetes" {
  load_balancer_id = hcloud_load_balancer.api.id
  protocol         = "tcp"
  listen_port      = 6443
  destination_port = 6443

  health_check {
    protocol = "tcp"
    port     = 6443
    interval = 5
    timeout  = 3
    retries  = 3
  }
}

resource "hcloud_load_balancer_service" "talos" {
  load_balancer_id = hcloud_load_balancer.api.id
  protocol         = "tcp"
  listen_port      = 50000
  destination_port = 50000

  health_check {
    protocol = "tcp"
    port     = 50000
    interval = 5
    timeout  = 3
    retries  = 3
  }
}

resource "hcloud_load_balancer" "ingress" {
  name               = "${var.cluster_name}-ingress"
  load_balancer_type = var.ingress_lb_type
  location           = var.worker_locations[0]
  labels             = local.labels
}

resource "hcloud_load_balancer_network" "ingress" {
  load_balancer_id = hcloud_load_balancer.ingress.id
  network_id       = hcloud_network.cluster.id
  ip               = local.ingress_lb_private_ip

  depends_on = [hcloud_network_subnet.nodes]
}

resource "hcloud_load_balancer_target" "ingress" {
  for_each = local.ingress_targets

  load_balancer_id = hcloud_load_balancer.ingress.id
  type             = "server"
  server_id        = hcloud_server.node[each.key].id
  use_private_ip   = true

  depends_on = [hcloud_load_balancer_network.ingress]
}

# TCP passthrough with the PROXY protocol: TLS ends in the cluster
# (cert-manager), and the ingress controller still sees the client address,
# which WeldSign's evidence trail records.
resource "hcloud_load_balancer_service" "http" {
  load_balancer_id = hcloud_load_balancer.ingress.id
  protocol         = "tcp"
  listen_port      = 80
  destination_port = var.ingress_node_ports.http
  proxyprotocol    = true

  health_check {
    protocol = "tcp"
    port     = var.ingress_node_ports.http
    interval = 10
    timeout  = 5
    retries  = 3
  }
}

resource "hcloud_load_balancer_service" "https" {
  load_balancer_id = hcloud_load_balancer.ingress.id
  protocol         = "tcp"
  listen_port      = 443
  destination_port = var.ingress_node_ports.https
  proxyprotocol    = true

  health_check {
    protocol = "tcp"
    port     = var.ingress_node_ports.https
    interval = 10
    timeout  = 5
    retries  = 3
  }
}
