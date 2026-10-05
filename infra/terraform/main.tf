terraform {
  required_version = ">= 1.7.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "aws_region" {
  type = string
}

variable "localstack_sqs_endpoint" {
  type = string
}

provider "aws" {
  region                      = var.aws_region
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true

  endpoints {
    sqs = var.localstack_sqs_endpoint
  }
}

resource "aws_sqs_queue" "wager_transactions_dlq" {
  name                        = "wager-transactions-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
}

resource "aws_sqs_queue" "wager_transactions" {
  name                        = "wager-transactions.fifo"
  fifo_queue                  = true
  content_based_deduplication = false

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.wager_transactions_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "wager_transactions_dlq" {
  queue_url = aws_sqs_queue.wager_transactions_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.wager_transactions.arn]
  })
}

resource "aws_sqs_queue" "wager_events" {
  name                        = "wager-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
}

output "wager_transactions_queue_url" {
  value = aws_sqs_queue.wager_transactions.id
}

output "wager_transactions_dlq_url" {
  value = aws_sqs_queue.wager_transactions_dlq.id
}

output "wager_events_queue_url" {
  value = aws_sqs_queue.wager_events.id
}
