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

variable "labels" {
  description = "Extra labels on every resource."
  type        = map(string)
  default     = {}
}
