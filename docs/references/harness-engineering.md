# Harness engineering

This project follows the approach in [OpenAI's harness-engineering article](https://openai.com/index/harness-engineering/).
The practical rules are a short AGENTS map, indexed repository knowledge, explicit package
boundaries, reproducible feedback and a persistent work graph. Human choices become decisions;
repeated review findings become tests, lints or clearer documentation.

Use [core beliefs](../design-docs/core-beliefs.md), [the architecture](../../ARCHITECTURE.md)
and [Beads](../PLANS.md) to apply the approach. Documentation, tests and checks are part of the
product. When an agent lacks context or a capability, improve the environment and leave that
improvement discoverable. No copied private planning history is required to work here.
