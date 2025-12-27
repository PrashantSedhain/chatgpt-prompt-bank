# App Runner instance role (runtime AWS permissions)

This service uses AWS SDK clients at runtime:
- Bedrock Runtime (`InvokeModel`) for embeddings
- S3 Vectors (`CreateIndex`, `GetIndex`, `PutVectors`, `GetVectors`, `DeleteVectors`, `QueryVectors`, `ListVectors`)

## Trust policy (who can assume the role)

Create an IAM role (example name: `AppRunnerInstanceRole`) with this trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "tasks.apprunner.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

## Permissions policy (what the app can do)

Attach a policy like the below and tighten as needed.

Notes:
- Bedrock model access is controlled both by IAM and by Bedrock “model access” settings in the region.
- S3 Vectors IAM resource scoping can vary; if you see `AccessDenied` with a resource ARN mismatch, temporarily switch the `Resource` for the S3 Vectors statement to `"*"` and then re-tighten.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockEmbeddings",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0"
      ]
    },
    {
      "Sid": "S3VectorsPromptBank",
      "Effect": "Allow",
      "Action": [
        "s3vectors:CreateIndex",
        "s3vectors:GetIndex",
        "s3vectors:PutVectors",
        "s3vectors:GetVectors",
        "s3vectors:DeleteVectors",
        "s3vectors:QueryVectors",
        "s3vectors:ListVectors"
      ],
      "Resource": [
        "arn:aws:s3vectors:us-east-1:559118953851:bucket/prompt-bank-vectors",
        "arn:aws:s3vectors:us-east-1:559118953851:bucket/prompt-bank-vectors/*"
      ]
    }
  ]
}
```

## Wiring into the workflow

Set GitHub secret `APPRUNNER_INSTANCE_ROLE_ARN` to the role ARN (example):
`arn:aws:iam::559118953851:role/AppRunnerInstanceRole`

