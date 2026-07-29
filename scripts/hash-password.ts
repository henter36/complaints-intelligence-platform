import { hashPassword } from "../src/server/auth/password-service";

async function readPasswordFromStdin(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += String(chunk);
    }
    return input.trimEnd();
  }

  return new Promise((resolve) => {
    const stdin = process.stdin;
    let password = "";

    process.stdout.write("Password: ");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(password);
    };

    stdin.on("data", (key: string) => {
      if (key === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      }

      if (key === "\r" || key === "\n") {
        finish();
        return;
      }

      if (key === "\u007f") {
        password = password.slice(0, -1);
        return;
      }

      password += key;
    });
  });
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    console.error("Do not pass passwords as command arguments. Use the hidden prompt or protected stdin.");
    process.exit(1);
  }

  const password = await readPasswordFromStdin();
  const hash = await hashPassword(password);
  console.log(hash);
}

void main();
