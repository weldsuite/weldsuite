# The EU cluster on Hetzner Cloud: servers, network, firewall, load balancers
# and the Talos bootstrap. Flux takes over from the kubeconfig this outputs
# (rust/deploy/flux). Runbook: README.md; monthly drill: DRILL.md.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.70.0"
    }
    talos = {
      source  = "siderolabs/talos"
      version = "0.12.0"
    }
  }

  # State holds the Talos machine secrets and the kubeconfig: keep it in an
  # encrypted remote backend, never in git. Hetzner Object Storage speaks S3:
  #
  # backend "s3" {
  #   bucket                      = "weldsuite-tofu-state"
  #   key                         = "eu/terraform.tfstate"
  #   region                      = "fsn1"
  #   endpoints                   = { s3 = "https://fsn1.your-objectstorage.com" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   use_path_style              = true
  # }
  #
  # and OpenTofu's state encryption on top (encryption { ... }, see README.md).
}

provider "hcloud" {
  token = var.hcloud_token
}
