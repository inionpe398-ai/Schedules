import { migrate } from "../server/db.js";
migrate();
console.log("Database migrations applied.");
