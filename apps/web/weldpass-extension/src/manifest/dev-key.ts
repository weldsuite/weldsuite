/**
 * The development key pair's public half (base64 SubjectPublicKeyInfo), which
 * pins the extension id of every unpacked and test build to
 * `nlmnjlkgeoeklbahlemmlcfnlfgdimnp`. WeldID's `weldsuite-extension` client lists that id's
 * redirect, `https://nlmnjlkgeoeklbahlemmlcfnlfgdimnp.chromiumapp.org/`, so a build loaded
 * unpacked on any machine can sign in.
 *
 * A public key, not a secret. The private half is not in this repository and
 * isn't needed: unpacked extensions are never signed. The Chrome Web Store
 * and Edge Add-ons sign the store build with keys of their own, and a store
 * upload must carry no `key` at all (`buildManifest` leaves it out in
 * store mode).
 */
export const DEVELOPMENT_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwZL2ln1frEQd/AMra/isq6uIol1QnyuAyR9vuk6+w65Z94403dc2+AzUGVrvQvDe3pKJPIhGjDgUEj3ZQ39EdwpdyUIL8+N8Ui4+VHTBj/RBKe4UxaD89muxnhaFdhWFBQ+EXIvaLQCUOCAWsZdX6BWdg3ws+KVXisbzngoDz+vcOkHwfQDggdyQhkaZdkfLMr75mEiNsbQX4Oh9E7d6DehYqxUcrxPZA4EMrjcQmKUHsxY9IBRnvctS/ZP2W+DqPU3h3wjys96W8PTKn7FLmiISuqRUxcDyKUr2ahiQ2bXKij54vCbZcLcI/HQP8m2iDdWF1hs5DwWwJq5MMnCOHQIDAQAB';

export const DEVELOPMENT_ID = 'nlmnjlkgeoeklbahlemmlcfnlfgdimnp';
