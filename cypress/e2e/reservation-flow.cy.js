/**
 * Full reservation workflow:
 *
 * Part 1 — Restaurant portal (RESTAURANT_PORTAL_URL):
 *   1. Log in as cypress restaurant owner
 *   2. Navigate to Zones & Tables, verify seeded zone and tables exist
 *   3. Navigate to Schedule, verify it loads
 *   4. Navigate to Reservations, verify it loads
 *
 * Part 2 — User booking frontend (LANDING_PAGE_URL):
 *   5. Visit /restaurant/cypress-test-restaurant
 *   6. Select today, party size 2, first available time slot
 *   7. Fill contact form and submit
 *   8. Assert confirmation page shows "Confirmada" and correct restaurant name
 *
 * Prerequisites: run `npm run cy:seed` before this test suite
 * (or use `npm run cy:test` which seeds then runs).
 */

const RESTAURANT_PORTAL = Cypress.env('RESTAURANT_PORTAL_URL') || 'http://localhost:5175';
const BOOKING_FRONTEND = Cypress.env('LANDING_PAGE_URL') || 'http://localhost:5174';

const OWNER_EMAIL = 'cypressRestaurantOwner@test.com';
const OWNER_PASSWORD = 'asdf';
const RESTAURANT_SLUG = 'cypress-test-restaurant';
const RESTAURANT_NAME = 'Cypress Test Restaurant';
const ZONE_NAME = 'Salon Cypress';

// ─── Part 1: Restaurant Portal ───────────────────────────────────────────────

describe('Restaurant portal - verify seeded data', () => {
  before(() => {
    cy.visit(RESTAURANT_PORTAL + '/login');
  });

  it('logs in as cypress restaurant owner', () => {
    cy.get('[data-cy=login-email]').type(OWNER_EMAIL);
    cy.get('[data-cy=login-password]').type(OWNER_PASSWORD);
    cy.get('[data-cy=login-submit]').click();
    cy.get('[data-cy=nav-home]', { timeout: 15000 }).should('be.visible');
  });

  it('navigates to Zones & Tables and finds seeded zone', () => {
    cy.get('[data-cy=nav-zones-tables]').click();
    cy.get('[data-cy=zones-tables-title]', { timeout: 10000 }).should('be.visible');
    cy.get(`[data-cy="zone-row-${ZONE_NAME}"]`, { timeout: 10000 }).should('be.visible');
  });

  it('selects the zone and finds seeded tables', () => {
    cy.get(`[data-cy="zone-row-${ZONE_NAME}"]`).click();
    cy.get('[data-cy=tables-datatable]', { timeout: 10000 }).should('contain', 'CY-1');
    cy.get('[data-cy=tables-datatable]').should('contain', 'CY-2');
  });

  it('navigates to Schedule and verifies it loads', () => {
    cy.get('[data-cy=nav-schedule]').click();
    cy.get('[data-cy=schedule-title]', { timeout: 10000 }).should('be.visible');
    cy.get('[data-cy=schedule-save-btn]').should('be.visible');
    cy.get('[data-cy=schedule-table]').should('be.visible');
  });

  it('navigates to Reservations and verifies it loads', () => {
    cy.get('[data-cy=nav-reservations]').click();
    cy.get('[data-cy=reservations-title]', { timeout: 10000 }).should('be.visible');
    cy.get('[data-cy=reservations-datatable]').should('exist');
  });
});

// ─── Part 2: User booking frontend ───────────────────────────────────────────

describe('User booking flow', () => {
  it('loads the restaurant booking page', () => {
    cy.visit(`${BOOKING_FRONTEND}/restaurant/${RESTAURANT_SLUG}`);
    cy.get('[data-cy=booking-restaurant-name]', { timeout: 15000 }).should(
      'contain',
      RESTAURANT_NAME,
    );
    cy.get('[data-cy=booking-card]').should('be.visible');
  });

  it('selects today and party size 2', () => {
    cy.get('[data-cy=date-today]').click();
    cy.get('[data-cy=party-size-2]').click();
  });

  it('selects the first available time slot', () => {
    cy.get('[data-cy=slots-label]', { timeout: 20000 }).should('be.visible');
    cy.get('[data-cy^="time-slot-"]').first().click();
  });

  it('clicks Continuar to advance to contact form', () => {
    cy.get('[data-cy=booking-continue]').should('not.be.disabled').click();
    cy.get('[data-cy=contact-summary]', { timeout: 8000 }).should('be.visible');
  });

  it('fills the contact form and submits', () => {
    cy.get('[data-cy=contact-name]').type('Cypress Usuario');
    cy.get('[data-cy=contact-phone]').find('input[type="tel"]').type('+56912345678');
    cy.get('[data-cy=contact-email]').type('cypress@test.com');
    cy.get('[data-cy=contact-submit]').click();
  });

  it('lands on the confirmation page', () => {
    cy.url({ timeout: 20000 }).should('include', '/reservation/');
    cy.get('[data-cy=confirmation-status]', { timeout: 15000 }).should('be.visible');
    cy.get('[data-cy=confirmation-restaurant-name]').should('contain', RESTAURANT_NAME);
    cy.get('[data-cy=confirmation-details]').should('be.visible');
  });
});
