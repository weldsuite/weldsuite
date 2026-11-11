variable "hcloud_token" {
  description = "Hetzner Cloud API token (read/write) of the project the cluster lives in."
  type        = string
  sensitive   = true
}

variable "cluster_name" {
  description = "Name of the cluster; prefixes every resource. The drill uses its own (weldsuite-drill)."
  type        = string
  default     = "weldsuite-eu"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.cluster_name))
    error_message = "cluster_name: lowercase letters, digits and dashes, 3-31 characters."
  }
}

variable "domain" {
  description = "Base domain. The API is api.<domain>, sign-in auth.<domain>, the signer portal sign.<domain>."
  type        = string
}

variable "api_hostname" {
  description = "Hostname of the Kubernetes API in the kubeconfig. Empty: the API load balancer's IPv4."
  type        = string
  default     = ""
}

variable "talos_version" {
  description = "Talos release of the image and the machine configs."
  type        = string
  default     = "v1.14.3"
}

variable "kubernetes_version" {
  description = "Kubernetes version; empty uses the Talos release's default."
  type        = string
  default     = ""
}

variable "talos_image_selector" {
  description = "Label selector of the Talos snapshot made by scripts/upload-talos-image.sh."
  type        = string
  default     = "os=talos"
}

variable "network_zone" {
  description = "Hetzner network zone holding every location below."
  type        = string
  default     = "eu-central"
}

variable "network_cidr" {
  description = "Private network of the cluster. Nodes talk to each other, the load balancers and etcd over it."
  type        = string
  default     = "10.10.0.0/16"
}

variable "nodes_subnet_cidr" {
  type    = string
  default = "10.10.1.0/24"
}

variable "pod_cidr" {
  type    = string
  default = "10.244.0.0/16"
}

variable "service_cidr" {
  type    = string
  default = "10.96.0.0/12"
}

variable "control_plane_locations" {
  description = "One control-plane node per entry. Two main locations and a Helsinki tie-breaker keep etcd quorum when one location fails."
  type        = list(string)
  default     = ["fsn1", "nbg1", "hel1"]

  validation {
    condition     = length(var.control_plane_locations) % 2 == 1
    error_message = "Use an odd number of control-plane nodes (etcd quorum)."
  }
}

variable "control_plane_type" {
  description = "Server type of the control-plane nodes. The drill falls back to control_plane_type_fallbacks when it is not available."
  type        = string
  default     = "cpx22"
}

variable "worker_locations" {
  description = "Locations of the general workers, round robin. Every stateless role runs at least two replicas in two locations."
  type        = list(string)
  default     = ["fsn1", "nbg1"]
}

variable "worker_count" {
  description = "General workers. 0 runs every workload on the control plane, ingress included: a small test cluster, not production."
  type        = number
  default     = 3

  validation {
    condition     = var.worker_count >= 0
    error_message = "worker_count can't be negative."
  }
}

variable "worker_type" {
  type    = string
  default = "cpx32"
}

variable "livekit_worker_count" {
  description = "General workers that also run LiveKit, WeldMeet's media server, counted from worker-1, so the default two sit in both locations. They get the node.weldsuite.org/livekit label and the livekit firewall (WebRTC and TURN ports). 0: no video."
  type        = number
  default     = 2

  validation {
    condition     = var.livekit_worker_count >= 0 && var.livekit_worker_count <= var.worker_count
    error_message = "livekit_worker_count: between 0 and worker_count."
  }
}

# The MTA's IP pools (docs/plans/eu-mail-service.md): `system` for the
# platform's own mail, `customer` for what people write. Each pool is its own
# servers, each with a primary IPv4 that outlives the server and its reverse
# DNS, round robin over the pool's locations. Private addresses: 10 per pool
# from .60, pools in name order, so a new pool whose name sorts before an
# existing one moves that one's addresses; name it to sort last.
variable "mail_pools" {
  description = "Mail node pools: pool name => { count, type, locations }. Nodes are mail<n>-<pool>.<domain>, labelled weldsuite.org/mail-pool=<pool> and tainted weldsuite.org/mail. Empty: no mail nodes."
  type = map(object({
    count     = number
    type      = optional(string, "cpx22")
    locations = list(string)
  }))
  default = {}

  validation {
    condition     = length(var.mail_pools) <= 4
    error_message = "mail_pools: at most 4 pools (private addresses .60-.99)."
  }

  validation {
    condition = alltrue([
      for name, pool in var.mail_pools :
      can(regex("^[a-z][a-z0-9]{0,15}$", name)) && pool.count >= 0 && pool.count <= 10 && length(pool.locations) > 0
    ])
    error_message = "mail_pools: names are lowercase letters and digits (they become MTA_SUBMISSION_PASSWORD_<POOL>), 0-10 nodes per pool, at least one location."
  }
}

# A pool can also send from a node the cluster already has, instead of a
# dedicated mail server: no extra server or address, at the price of sharing
# the node (and its address) with the node's other workloads.
variable "mail_pool_nodes" {
  description = "Mail pools on existing cluster nodes: pool name => node key (worker-1, or cp-2 on a cluster without general workers). The node sends from its own public IPv4, which gets the PTR mail1-<pool>.<domain>, the mail firewall (inbound 25) and the weldsuite.org/mail-pool label, but no taint, so its other workloads stay. Only untainted nodes: the MTA's DaemonSet tolerates the mail taint alone, so not the Postgres nodes, nor control-plane nodes while worker_count > 0. A pool is in mail_pools or here, not both. Empty: none."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for pool, node in var.mail_pool_nodes :
      can(regex("^[a-z][a-z0-9]{0,15}$", pool)) && can(regex("^(cp|worker)-[0-9]+$", node))
    ])
    error_message = "mail_pool_nodes: pool names are lowercase letters and digits; nodes are general workers (worker-1) or, on a cluster without them, control-plane nodes (cp-2). Not the Postgres nodes: they are tainted, and the MTA can't run there."
  }

  validation {
    condition     = length(distinct(values(var.mail_pool_nodes))) == length(var.mail_pool_nodes)
    error_message = "mail_pool_nodes: one pool per node (each pool needs its own address)."
  }
}

variable "postgres_locations" {
  description = "CloudNativePG nodes, one per entry: primary and synchronous replica in different locations."
  type        = list(string)
  default     = ["fsn1", "nbg1"]
}

variable "postgres_type" {
  description = "Server type of the Postgres pool: dedicated vCPU with local NVMe (CCX), so storage never depends on Cloud Volumes."
  type        = string
  default     = "ccx23"
}

variable "admin_cidrs" {
  description = "Addresses allowed to reach the Kubernetes (6443) and Talos (50000) APIs. Keep it to the operators and the drill runner."
  type        = list(string)
}

variable "ingress_lb_type" {
  type    = string
  default = "lb11"
}

variable "api_lb_type" {
  type    = string
  default = "lb11"
}

# A load balancer's address is in DNS and every kubeconfig and talosconfig, and
# changing its location replaces it. These keep one where it is when the nodes
# move to another location.
variable "api_lb_location" {
  description = "Location of the API load balancer. Empty: the first control-plane location."
  type        = string
  default     = ""
}

variable "ingress_lb_location" {
  description = "Location of the ingress load balancer. Empty: the first worker location."
  type        = string
  default     = ""
}

variable "ingress_node_ports" {
  description = "NodePorts of the ingress controller's HTTP and HTTPS ports (Traefik in rust/deploy/flux)."
  type = object({
    http  = number
    https = number
  })
  default = {
    http  = 30080
    https = 30443
  }
}

variable "mx_node_port" {
  description = "NodePort of WeldMail's MX (Haraka, the chart's mailInbound with service type NodePort). Set: the ingress load balancer also forwards port 25 there, with the PROXY protocol, and mx.<domain> joins dns_records. 0: no MX."
  type        = number
  default     = 0

  validation {
    condition     = var.mx_node_port == 0 || (var.mx_node_port >= 30000 && var.mx_node_port <= 32767)
    error_message = "mx_node_port: 0, or a NodePort (30000-32767)."
  }
}

variable "labels" {
  description = "Extra labels on every resource."
  type        = map(string)
  default     = {}
}
