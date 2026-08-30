import { type Greeting, createGreeting } from "./modules/greeting";

const greeting: Greeting = createGreeting("benchmark");
export const app = greeting.text;
