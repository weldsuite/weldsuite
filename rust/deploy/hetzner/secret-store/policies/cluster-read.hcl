# The cluster's token (External Secrets Operator, rust/deploy/flux/secrets):
# reads values and writes nothing. OpenBao's default policy adds what every
# token may do to itself (look itself up, renew, revoke).
path "secret/data/*" {
  capabilities = ["read"]
}
