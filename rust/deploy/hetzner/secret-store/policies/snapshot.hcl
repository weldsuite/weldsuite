# The snapshot timer's token (bao-snapshot): a Raft snapshot, nothing else.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
