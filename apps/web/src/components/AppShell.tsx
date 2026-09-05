import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  BookOpen, CalendarDays, ClipboardCheck, CreditCard, GraduationCap,
  LayoutDashboard, LogOut, Menu, Mic, Bell, Users, X,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { Avatar } from './ui/Avatar';
import { cn } from '../lib/cn';
import type { Role } from '../types/api';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Shown only when the signed-in user holds this permission. */
  permission?: string;
  roles?: Role[];
}

/**
 * One navigation definition for the whole product.
 *
 * Each entry declares the permission it needs, so the sidebar and the route
 * guards agree by construction. A screen never appears in the menu that the
 * user would then be refused.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard },
  { to: '/today', label: 'Today', icon: CalendarDays, permission: 'selfstudy.session.own' },
  { to: '/attendance', label: 'Attendance', icon: ClipboardCheck, permission: 'attendance.mark' },
  { to: '/tests', label: 'Tests', icon: GraduationCap, permission: 'tests.read' },
  { to: '/materials', label: 'Material', icon: BookOpen, permission: 'materials.read' },
  { to: '/viva', label: 'Viva', icon: Mic, permission: 'viva.conduct' },
  { to: '/people', label: 'People', icon: Users, permission: 'users.read' },
  { to: '/fees', label: 'Fees', icon: CreditCard, permission: 'fees.read.own' },
];

export function AppShell() {
  const { user, signOut, can } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const visible = NAV.filter((item) => !item.permission || can(item.permission));
  const name = user ? `${user.firstName} ${user.lastName}` : '';

  return (
    <div className="app-shell relative flex min-h-screen overflow-hidden bg-surface-sunken">
      {/* ---------- sidebar ---------- */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-ink text-white transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-5 py-6">
          <div className="flex items-center gap-3">
            <img src="/tsa-logo.png" alt="The Scholastic Academy" className="h-10 w-10 rounded-xl object-cover" />
            <div>
              <div className="font-display text-xl font-bold leading-none tracking-tight text-white">TSA</div>
              <div className="mt-1 font-sans text-[10px] font-medium uppercase tracking-[0.14em] text-white/45">
                strive for success
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="rounded-md p-1 text-white/60 hover:bg-white/10 lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[14px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                  isActive ? 'bg-brand text-white shadow-lg shadow-black/10' : 'text-white/65 hover:bg-white/10 hover:text-white',
                )
              }
            >
              <item.icon size={17} strokeWidth={2} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <Avatar name={name} url={user?.avatarUrl} size={32} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{name}</p>
              <p className="truncate text-[11px] capitalize text-white/50">
                {user?.role.toLowerCase()}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] text-white/65 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {open ? (
        <div
          className="fixed inset-0 z-30 bg-ink/40 lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}

      {/* ---------- main ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 flex h-14 items-center gap-3 border-b border-line bg-surface-raised px-4 lg:px-7">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1.5 text-ink-soft hover:bg-surface-sunken lg:hidden"
          >
            <Menu size={20} />
          </button>

          <h1 className="font-display text-[15px] font-semibold capitalize text-ink">
            {visible.find((item) => item.to === location.pathname)?.label ?? 'TSA'}
          </h1>

          <NavLink
            to="/notifications"
            className="ml-auto rounded-md p-2 text-ink-soft hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            aria-label="Notifications"
          >
            <Bell size={18} />
          </NavLink>
        </header>

        <main className="relative z-10 flex-1 px-4 py-6 lg:px-10 lg:py-9">
          <Outlet />
        </main>
      </div>
      <img
        src="/tsa-logo.png"
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute right-[4%] top-[18%] z-0 w-[min(48vw,560px)] opacity-[0.08] grayscale mix-blend-multiply"
      />
    </div>
  );
}
