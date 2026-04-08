const { defineConfig } = require('cypress');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:5174',
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.{js,ts}',
    defaultCommandTimeout: 15000,
    pageLoadTimeout: 30000,
    chromeWebSecurity: false,
    setupNodeEvents(on, config) {
      require('dotenv').config({ path: path.resolve(__dirname, '.env') });

      config.env = {
        ...config.env,
        BACKEND_URL: 'http://localhost:3000',
        RESTAURANT_PORTAL_URL: 'http://localhost:5175',
        LANDING_PAGE_URL: 'http://localhost:5174',
      };

      return config;
    },
  },
});
