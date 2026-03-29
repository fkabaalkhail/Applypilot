import { Link, Outlet } from "react-router-dom";

export default function App() {
  return (
    <>
      <nav>
        <Link to="/">Dashboard</Link>
        <Link to="/run">Bot Runner</Link>
        <Link to="/review">Review</Link>
        <Link to="/settings">Settings</Link>
      </nav>
      <div className="container">
        <Outlet />
      </div>
    </>
  );
}
