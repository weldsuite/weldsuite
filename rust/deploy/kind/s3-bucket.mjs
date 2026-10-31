// Create an S3 bucket (CreateBucket, AWS Signature Version 4) on an S3 store
// the script reaches, for the kind smoke test: there is no aws CLI there.
//
//   node s3-bucket.mjs <endpoint> <bucket> <access key id> <secret key> [region]
//
// An existing bucket is fine (409 BucketAlreadyOwnedByYou).
import { createHash, createHmac } from 'node:crypto';

const [endpoint, bucket, accessKeyId, secretAccessKey, region = 'us-east-1'] = process.argv.slice(2);
if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('usage: node s3-bucket.mjs <endpoint> <bucket> <access key id> <secret key> [region]');
  process.exit(2);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

const url = new URL(`/${bucket}`, endpoint);
const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const day = amzDate.slice(0, 8);
const payloadHash = sha256('');
const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
const canonical = ['PUT', url.pathname, '', `host:${url.host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, '', signedHeaders, payloadHash].join('\n');
const scope = `${day}/${region}/s3/aws4_request`;
const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
const signature = createHmac('sha256', key).update(toSign).digest('hex');

const res = await fetch(url, {
  method: 'PUT',
  headers: {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  },
});
const body = await res.text();
if (res.ok || res.status === 409) {
  console.log(`bucket ${bucket}: ${res.status}`);
} else {
  console.error(`bucket ${bucket}: ${res.status} ${body.slice(0, 300)}`);
  process.exit(1);
}
