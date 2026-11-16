import { useRouter, type Href } from 'expo-router';

import { FLOW_ROUTES, type AddCommunityFlow, type FlowRoutes } from '../domain/flowRoutes';

/**
 * Navigation for the join / create screens, which run both in onboarding and
 * (for someone who already has a community) inside the app. The routes come
 * from `FLOW_ROUTES`, never from user input.
 */
export function useFlowNavigation(flow: AddCommunityFlow) {
  const router = useRouter();
  const routes = FLOW_ROUTES[flow];
  return {
    routes,
    /** Opens one of the flow's own screens. */
    goTo: (key: keyof FlowRoutes) => router.push(routes[key] as Href),
    back: () => router.back(),
    /**
     * Leaves the flow for the app's first screen. In onboarding there is no
     * app to return to: the gate moves the user once the membership exists.
     */
    exitToApp: () => {
      if (flow === 'signedIn') router.dismissTo('/' as Href);
    },
  };
}
