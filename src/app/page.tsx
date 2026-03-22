import { ThemeToggle } from "@/components/theme-toggle";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-foreground">Aimer Web</h1>
        <ThemeToggle className="mt-4" />
      </div>
    </main>
  );
}
