# Cypress E2E conventions (backend-simple-reserva)

These rules apply to specs under `cypress/e2e/` and the Cypress seed in `cypress/scripts/seed.js`.

## Dev / seeded passwords

- All passwords created or refreshed by **this** Cypress seed must be **`asdf`**, matching `prisma/seed.js` (`seedPassword`).
- Do not introduce alternate test passwords (for example `testpass123`) in seed or specs.

## Restaurant portal login (PrimeReact `Password`)

- The login password field uses `[data-cy="login-password"]` on the PrimeReact `Password` wrapper.
- **Do:** `cy.get('[data-cy=login-password]').type(password)`
- **Do not:** `cy.get('[data-cy=login-password]').find('input').type(...)` — it fails because the `data-cy` target is not the inner `<input>`.

## Before running E2E

- Run `npm run cy:seed` (or `npm run cy:test`, which seeds first) so users and restaurant data exist.
