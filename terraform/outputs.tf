output "public_ip" {
  value       = oci_core_instance.app.public_ip
  description = "Point your DNS A record here, then set DOMAIN in the server's .env."
}

output "backup_bucket" {
  value = oci_objectstorage_bucket.backups.name
}

output "object_storage_namespace" {
  value = data.oci_objectstorage_namespace.ns.namespace
}

output "s3_compat_endpoint" {
  value       = "https://${data.oci_objectstorage_namespace.ns.namespace}.compat.objectstorage.${var.region}.oraclecloud.com"
  description = "S3-compatible endpoint used by the backup job (needs a Customer Secret Key, see SETUP.md)."
}
