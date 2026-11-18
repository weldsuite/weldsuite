# A cluster's secret store: one OpenBao server outside the cluster, which the
# cluster's External Secrets Operator reads over the Vault API. Its own
# state, apart from the cluster's, so a cluster's `tofu destroy` (the drill
# runs one every month) never reaches it. Runbook: README.md.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.70.0"
    }
  }

  # The state holds no secret (the store's keys and tokens are made on the
  # server, never by OpenTofu), but it is the only easy way to change the
  # server: keep it, as the cluster's (../README.md, step 3).
}

provider "hcloud" {
  token = var.hcloud_token
}
