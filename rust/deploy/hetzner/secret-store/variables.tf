variable "hcloud_token" {
  description = "Hetzner Cloud API token (read/write) of the project the store lives in."
  type        = string
  sensitive   = true
}

variable "name" {
  description = "Server, firewall and Raft node name, e.g. weldsuite-eu-secrets. One store per cluster."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,62}$", var.name))
    error_message = "name: lowercase letters, digits and dashes, 3-63 characters."
  }
}

variable "hostname" {
  description = "The store's DNS name (secrets.<domain>). Caddy gets its certificate for it, and it is the cluster's SECRET_STORE_URL (https://<hostname>)."
  type        = string
}

variable "acme_email" {
  description = "Let's Encrypt account email for the store's certificate."
  type        = string
}

variable "admin_cidrs" {
  description = "Operators' addresses: SSH, and the whole Vault API (writes, snapshots, tokens). From anywhere else only reading a value, looking up one's own token and the health check get through."
  type        = list(string)

  validation {
    condition     = length(var.admin_cidrs) > 0 && !contains(var.admin_cidrs, "0.0.0.0/0") && !contains(var.admin_cidrs, "::/0")
    error_message = "admin_cidrs: at least one address, and not the whole internet."
  }
}

variable "ssh_keys" {
  description = "Names or ids of the Hetzner Cloud SSH keys let in as root."
  type        = list(string)

  validation {
    condition     = length(var.ssh_keys) > 0
    error_message = "ssh_keys: at least one; the store is set up and unsealed over SSH."
  }
}

variable "location" {
  description = "Hetzner location. Any works: while the store is unreachable the cluster keeps the Secrets it has and only stops refreshing them."
  type        = string
  default     = "hel1"
}

variable "server_type" {
  description = "x86 server type (the OpenBao package below is amd64). OpenBao, Caddy and Debian fit in 1 GB. A running server can be rescaled to a type with the same or a bigger disk, never a smaller one."
  type        = string
  default     = "cpx02"

  validation {
    condition     = !startswith(var.server_type, "cax")
    error_message = "server_type: an x86 type; the pinned OpenBao package is amd64."
  }
}

variable "image" {
  type    = string
  default = "debian-13"
}

variable "backups" {
  description = "Hetzner's daily server backups (20% of the server's price), on top of the store's own snapshots to a second provider (README, \"Backups\")."
  type        = bool
  default     = true
}

# A new server installs this release; a running one is upgraded by hand
# (README, "Upgrades"), since cloud-init runs once. Take both from the
# release's checksums.txt.
variable "openbao_version" {
  type    = string
  default = "2.7.2"
}

variable "openbao_deb_sha256" {
  description = "SHA-256 of openbao_<version>_linux_amd64.deb (the release's checksums.txt)."
  type        = string
  default     = "42bd0890a8e2060e5f29410ea828ee047aa2de21028045731a0516d5a532928c"
}

variable "labels" {
  type    = map(string)
  default = {}
}
