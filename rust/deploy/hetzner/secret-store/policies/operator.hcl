# The operator's token: every value (seed-secrets.mjs, `bao kv`), the
# cluster's and the snapshot's tokens, and snapshots. Not the store's own
# settings (mounts, policies, auth methods): those take a root token, made
# when needed from the unseal keys (README, "Root token").
path "secret/*" {
  capabilities = ["create", "read", "update", "patch", "delete", "list"]
}

# New tokens only through the roles bao-configure makes, so their policies
# and lifetimes are fixed there.
path "auth/token/create/cluster" {
  capabilities = ["update"]
}

path "auth/token/create/snapshot" {
  capabilities = ["update"]
}

# Finding an old token by its accessor, and revoking it.
path "auth/token/accessors" {
  capabilities = ["list", "sudo"]
}

path "auth/token/lookup-accessor" {
  capabilities = ["update"]
}

path "auth/token/revoke-accessor" {
  capabilities = ["update"]
}

path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
