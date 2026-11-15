---
name: Tariff cash scenario
description: Compare weekly cash out for 12 weeks with duty exclusions kept and with exclusions ended after a chosen date
tools:
  - tariffScenario
  - cashForecast
  - entityBalances
chart: line
---
1. Say the scenario date. Use 9 Jan 2027 when the user gives no date.
2. Give total cash out over 12 weeks with exclusions kept and with exclusions ended after the date.
3. Name the weeks where duty adds the most cash out and the PO lines behind them.
4. Say if the cash balance still covers the higher number.
5. End with this line: Duty rates are entered by you. No live tariff feed.
6. Do not guess a duty rate or an exclusion date. Use only what is on the PO lines.
