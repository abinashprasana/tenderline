variable "region" {
  type        = string
  description = "OCI region identifier, e.g. eu-dublin-1."
}

variable "tenancy_ocid" {
  type        = string
  description = "Tenancy OCID (SETUP.md, Oracle Cloud)."
}

variable "user_ocid" {
  type        = string
  description = "OCID of the API user."
}

variable "fingerprint" {
  type        = string
  description = "Fingerprint of the API signing key."
}

variable "private_key_path" {
  type        = string
  description = "Path to the API signing private key."
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment to create resources in."
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key authorised on the VM (also used by the GitHub deploy job)."
}

variable "admin_cidr" {
  type        = string
  description = "CIDR allowed to SSH, e.g. 203.0.113.4/32. Do not use 0.0.0.0/0."
  validation {
    condition     = var.admin_cidr != "0.0.0.0/0"
    error_message = "SSH must not be open to the whole internet."
  }
}

variable "shape" {
  type    = string
  default = "VM.Standard.A1.Flex"
}

variable "ocpus" {
  type    = number
  default = 2
}

variable "memory_in_gbs" {
  type    = number
  default = 12
}

variable "boot_volume_gb" {
  type    = number
  default = 100
}

variable "availability_domain_index" {
  type    = number
  default = 0
}

variable "backup_bucket_name" {
  type    = string
  default = "tenderline-backups"
}
