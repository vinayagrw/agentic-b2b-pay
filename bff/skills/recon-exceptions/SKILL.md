---
name: Recon exceptions
description: Operator view of reconciliation exceptions, SLA breaches and stuck payments across clients
tools:
  - opsQueues
  - slaBreaches
  - paymentsByStatus
  - auditSearch
chart: table
roles:
  - operator
---
1. List open exceptions and the queue each one sits in.
2. Name payments that are past their SLA.
3. Group the rest by status.
4. Say which client needs attention first and why.
