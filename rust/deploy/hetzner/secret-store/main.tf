locals {
  labels = merge(var.labels, {
    role       = "secret-store"
    managed-by = "opentofu"
  })

  # Settings go to /etc/secret-store first and install.sh puts them in
  # place once the packages that own their real paths are installed (so no
  # package asks about a config file it finds already there).
  files = {
    "/etc/secret-store/install.sh" = {
      mode = "0700"
      content = templatefile("${path.module}/files/install.sh.tftpl", {
        openbao_version    = var.openbao_version
        openbao_deb_sha256 = var.openbao_deb_sha256
      })
    }
    "/etc/secret-store/openbao.hcl" = {
      mode = "0644"
      content = templatefile("${path.module}/files/openbao.hcl.tftpl", {
        name     = var.name
        hostname = var.hostname
      })
    }
    "/etc/secret-store/Caddyfile" = {
      mode = "0644"
      content = templatefile("${path.module}/files/Caddyfile.tftpl", {
        hostname    = var.hostname
        acme_email  = var.acme_email
        admin_cidrs = var.admin_cidrs
      })
    }
    "/etc/secret-store/policies/cluster-read.hcl" = {
      mode    = "0644"
      content = file("${path.module}/policies/cluster-read.hcl")
    }
    "/etc/secret-store/policies/operator.hcl" = {
      mode    = "0644"
      content = file("${path.module}/policies/operator.hcl")
    }
    "/etc/secret-store/policies/snapshot.hcl" = {
      mode    = "0644"
      content = file("${path.module}/policies/snapshot.hcl")
    }
    "/usr/local/sbin/bao-configure" = {
      mode    = "0755"
      content = file("${path.module}/files/bao-configure.sh")
    }
    "/usr/local/sbin/bao-snapshot" = {
      mode    = "0755"
      content = file("${path.module}/files/bao-snapshot.sh")
    }
    "/etc/systemd/system/bao-snapshot.service" = {
      mode    = "0644"
      content = <<-EOT
        [Unit]
        Description=Snapshot of the secret store to object storage
        After=openbao.service
        # Until README, "Backups" has written the settings.
        ConditionPathExists=/etc/secret-store/snapshot.env

        [Service]
        Type=oneshot
        ExecStart=/usr/local/sbin/bao-snapshot
      EOT
    }
    "/etc/systemd/system/bao-snapshot.timer" = {
      mode    = "0644"
      content = <<-EOT
        [Unit]
        Description=Daily snapshot of the secret store

        [Timer]
        OnCalendar=*-*-* 03:30:00
        RandomizedDelaySec=30m
        Persistent=true

        [Install]
        WantedBy=timers.target
      EOT
    }
    # SIGHUP makes OpenBao reopen its audit log.
    "/etc/logrotate.d/openbao" = {
      mode    = "0644"
      content = <<-EOT
        /var/log/openbao/audit.log {
          daily
          rotate 30
          compress
          delaycompress
          missingok
          notifempty
          create 0600 openbao openbao
          postrotate
            systemctl reload openbao >/dev/null 2>&1 || true
          endscript
        }
      EOT
    }
    # Debian's security updates, without reboots: after one the store comes
    # up sealed (README, "Reboots").
    "/etc/apt/apt.conf.d/20auto-upgrades" = {
      mode    = "0644"
      content = <<-EOT
        APT::Periodic::Update-Package-Lists "1";
        APT::Periodic::Unattended-Upgrade "1";
      EOT
    }
    "/etc/profile.d/openbao.sh" = {
      mode    = "0644"
      content = "export BAO_ADDR=http://127.0.0.1:8200\n"
    }
  }

  cloud_config = {
    package_update  = true
    package_upgrade = true
    packages        = ["caddy", "rclone", "unattended-upgrades"]
    write_files = [
      for path, f in local.files : {
        path        = path
        content     = f.content
        permissions = f.mode
        owner       = "root:root"
      }
    ]
    runcmd = [["bash", "/etc/secret-store/install.sh"]]
  }
}

# SSH and the whole API only from the operators (Caddy narrows the API
# further by address); 80 and 443 from anywhere, for Let's Encrypt and for
# the cluster, whose nodes' addresses this module doesn't know.
resource "hcloud_firewall" "store" {
  name   = var.name
  labels = local.labels

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.admin_cidrs
  }

  rule {
    description = "HTTP: Let's Encrypt, and the redirect to HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS: the Vault API through Caddy"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "ICMP"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "store" {
  name         = var.name
  server_type  = var.server_type
  location     = var.location
  image        = var.image
  ssh_keys     = var.ssh_keys
  firewall_ids = [hcloud_firewall.store.id]
  backups      = var.backups
  user_data    = "#cloud-config\n${yamlencode(local.cloud_config)}"
  labels       = local.labels

  # The store's data is on this server's disk: Hetzner refuses to delete or
  # rebuild it until these are turned off, and so does OpenTofu.
  delete_protection  = true
  rebuild_protection = true

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    # cloud-init runs once; a changed setting goes onto the running server
    # by hand (README), never through a rebuild.
    ignore_changes  = [user_data, image]
    prevent_destroy = true
  }
}
