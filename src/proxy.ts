import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Renamed from middleware.ts (Next.js 16 deprecated Middleware in favour of Proxy). This is not just a rename:
// Proxy defaults to the Node.js runtime, while Middleware ran on the Edge runtime — and Vercel's sensitive/secret
// environment variables are only available to Node.js functions, never to Edge. Every request 500'd in production
// because NEXT_PUBLIC_SUPABASE_URL/ANON_KEY (marked sensitive) came back empty under the old Edge middleware.
const PROTECTED_PREFIXES = ["/dashboard", "/leads", "/pipeline", "/ads", "/social", "/content", "/finance", "/projects", "/settings", "/onboarding"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isProtected = PROTECTED_PREFIXES.some((p) => request.nextUrl.pathname.startsWith(p));

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
