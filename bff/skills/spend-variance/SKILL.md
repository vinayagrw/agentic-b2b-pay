---
name: Spend variance
description: Explain why spend changed by comparing the last two months by supplier with the query tool
tools:
  - query?source=payments&measure=amount_sum&dimension=supplier&period=month&days=62
  - spendBySupplier
chart: bar
---
1. Compare spend in the two months side by side for each supplier.
2. Name the suppliers with the largest increase and the largest drop.
3. Give the total change in dollars and as a share of the earlier month.
4. Say which records explain the change and cite their ids.
