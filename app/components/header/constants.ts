import { EXTERNAL_LINKS } from '@/app/config';
import { ROUTES } from '@/app/constants/routes';

interface NavItem {
  label: string;
  path: string;
}

interface MenuLink {
  label: string;
  href: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Bridge', path: ROUTES.ROOT },
  { label: 'Transactions', path: ROUTES.TRANSACTIONS },
];

export const MENU_LINKS: MenuLink[] = [
  { label: 'Contact Support', href: EXTERNAL_LINKS.CONTACT_SUPPORT },
  { label: 'Privacy Policy', href: EXTERNAL_LINKS.PRIVACY_POLICY },
  { label: 'Terms of Use', href: EXTERNAL_LINKS.TERMS_OF_USE },
];
