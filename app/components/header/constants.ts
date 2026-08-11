import { getExternalLinks } from '@/app/config';
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
  { label: 'Transactions', path: ROUTES.TRANSACTIONS }
];

export const getMenuLinks = (): MenuLink[] => {
  const externalLinks = getExternalLinks();
  return [
    { label: 'Contact Support', href: externalLinks.CONTACT_SUPPORT },
    { label: 'Privacy Policy', href: externalLinks.PRIVACY_POLICY },
    { label: 'Terms of Use', href: externalLinks.TERMS_OF_USE }
  ];
};
