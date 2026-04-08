describe('Landing Page', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('loads successfully and shows the correct title', () => {
    cy.title().should('contain', 'SimpleReserva');
  });

  it('renders the hero section', () => {
    cy.get('#inicio').should('be.visible');
  });

  it('displays the main headline', () => {
    cy.get('#inicio').find('h1').should('contain', 'Llenas más mesas');
  });
});
