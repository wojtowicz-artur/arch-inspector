export type Greeting = { text: string };

export function createGreeting(name: string): Greeting {
  return { text: `hello ${name}` };
}
