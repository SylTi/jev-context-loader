import {serveFixtures} from './fixtures.js';
await serveFixtures(process.argv[2]??'h31',process.argv[3]);
