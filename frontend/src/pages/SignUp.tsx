import { SignUp } from "@clerk/clerk-react";

export default function SignUpPage() {
  return (
    <div className="auth-page">
      <SignUp
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
        afterSignUpUrl="/app"
      />
    </div>
  );
}
