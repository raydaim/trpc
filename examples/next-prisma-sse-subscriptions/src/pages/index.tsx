import { trpc } from '../utils/trpc';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { signIn, signOut, useSession } from 'next-auth/react';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Set isTyping with a throttle of 1s
 * Triggers immediately if state changes
 */
function useThrottledIsTypingMutation() {
  const isTyping = trpc.post.isTyping.useMutation();

  return useMemo(() => {
    let state = false;
    let timeout: ReturnType<typeof setTimeout> | null;
    function trigger() {
      timeout && clearTimeout(timeout);
      timeout = null;

      isTyping.mutate({ typing: state });
    }

    return (nextState: boolean) => {
      const shouldTriggerImmediately = nextState !== state;

      state = nextState;
      if (shouldTriggerImmediately) {
        trigger();
      } else if (!timeout) {
        timeout = setTimeout(trigger, 1000);
      }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
function AddMessageForm({ onMessagePost }: { onMessagePost: () => void }) {
  const addPost = trpc.post.add.useMutation();
  const { data: session } = useSession();
  const [message, setMessage] = useState('');
  const [isFocused, setIsFocused] = useState(true);
  async function postMessage() {
    const input = {
      text: message,
    };
    try {
      await addPost.mutateAsync(input);
      setMessage('');
      onMessagePost();
    } catch {}
  }

  const isTypingMutation = useThrottledIsTypingMutation();

  const userName = session?.user?.name;
  useEffect(() => {
    // update isTyping state
    isTypingMutation(isFocused && message.trim().length > 0);
  }, [isFocused, message, isTypingMutation]);

  if (!userName) {
    return (
      <div className="flex w-full justify-between rounded bg-gray-800 px-3 py-2 text-lg text-gray-200">
        <p className="font-bold">
          You have to{' '}
          <button
            className="inline font-bold underline"
            onClick={() => signIn()}
          >
            sign in
          </button>{' '}
          to write.
        </p>
        <button
          onClick={() => signIn()}
          data-testid="signin"
          className="h-full rounded bg-indigo-500 px-4"
        >
          Sign In
        </button>
      </div>
    );
  }
  return (
    <>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          /**
           * In a real app you probably don't want to use this manually
           * Checkout React Hook Form - it works great with tRPC
           * @link https://react-hook-form.com/
           */
          await postMessage();
        }}
      >
        <fieldset disabled={addPost.isPending} className="min-w-0">
          <div className="flex w-full items-end rounded bg-gray-500 px-3 py-2 text-lg text-gray-200">
            <textarea
              value={message}
              className="flex-1 bg-transparent outline-0"
              rows={message.split(/\r|\n/).length}
              id="text"
              name="text"
              autoFocus
              onChange={(e) => {
                setMessage(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void postMessage();
                }
              }}
              onFocus={() => {
                setIsFocused(true);
              }}
              onBlur={() => {
                setIsFocused(false);
              }}
            />
            <div>
              <button type="submit" className="rounded bg-indigo-500 px-4 py-1">
                Submit
              </button>
            </div>
          </div>
        </fieldset>
        {addPost.error && (
          <p style={{ color: 'red' }}>{addPost.error.message}</p>
        )}
      </form>
    </>
  );
}

export default function IndexPage() {
  const postsQuery = trpc.post.infinite.useInfiniteQuery(
    {},
    {
      getNextPageParam: (d) => d.nextCursor,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    },
  );
  const utils = trpc.useUtils();
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = postsQuery;

  // list of messages that are rendered
  const [messages, setMessages] = useState(() => {
    const msgs = postsQuery.data?.pages.map((page) => page.items).flat();
    return msgs;
  });
  type Post = NonNullable<typeof messages>[number];
  const { data: session } = useSession();
  const userName = session?.user?.name;
  const scrollTargetRef = useRef<HTMLDivElement>(null);

  // fn to add and dedupe new messages onto state
  const addMessages = useCallback((incoming?: Post[]) => {
    setMessages((current) => {
      const map: Record<Post['id'], Post> = {};
      for (const msg of current ?? []) {
        map[msg.id] = msg;
      }
      for (const msg of incoming ?? []) {
        map[msg.id] = msg;
      }
      return Object.values(map).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
    });
  }, []);

  // when new data from `useInfiniteQuery`, merge with current state
  useEffect(() => {
    const msgs = postsQuery.data?.pages.map((page) => page.items).flat();
    addMessages(msgs);
  }, [postsQuery.data?.pages, addMessages]);

  const scrollToBottomOfList = useCallback(() => {
    if (scrollTargetRef.current == null) {
      return;
    }

    scrollTargetRef.current.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }, [scrollTargetRef]);
  useEffect(() => {
    scrollToBottomOfList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // get the last known post as soon as we have it
  const lastEventId = useRef<string | null | undefined>(undefined);
  if (messages && lastEventId.current === undefined) {
    // set it as the last known event id (or null)
    // if we reconnect, we'll get all messages after this
    // since the SSE is sending `{id:x}` on each message, it will be updated by the EventStream as messages come in
    lastEventId.current = messages.at(-1)?.id ?? null;
  }

  // subscribe to new posts and add
  trpc.post.onAdd.useSubscription(
    {
      lastEventId: lastEventId.current,
    },
    {
      // Enable this subscription only if we have received some data
      enabled: lastEventId.current !== undefined,
      onData(event) {
        addMessages([event.data]);
        // scroll to bottom of list if we're at the bottom
        if (
          scrollTargetRef.current &&
          scrollTargetRef.current.getBoundingClientRect().top <
            window.innerHeight
        ) {
          setTimeout(() => {
            scrollToBottomOfList();
          }, 1);
        }
      },
      onError(err) {
        console.error('Subscription error:', err);
        // we might have missed a message - invalidate cache
        utils.post.infinite.invalidate();
      },
    },
  );

  const [currentlyTyping, setCurrentlyTyping] = useState<string[]>([]);
  trpc.post.whoIsTyping.useSubscription(undefined, {
    onData(event) {
      setCurrentlyTyping(event.data);
    },
  });

  return (
    <>
      <Head>
        <title>Prisma Starter</title>
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <div className="flex h-screen flex-col md:flex-row">
        <section className="flex w-full flex-col bg-gray-800 md:w-72">
          <div className="flex-1 overflow-y-hidden">
            <div className="flex h-full flex-col divide-y divide-gray-700">
              <header className="p-4">
                <h1 className="text-3xl font-bold text-gray-50">
                  tRPC SSE starter
                </h1>
                <p className="text-sm text-gray-400">
                  Showcases Server-sent Events + subscription support
                  <br />
                  <a
                    className="text-gray-100 underline"
                    href="https://github.com/trpc/trpc/tree/05-10-subscriptions-sse/examples/next-prisma-sse-subscriptions"
                    target="_blank"
                    rel="noreferrer"
                  >
                    View Source on GitHub
                  </a>
                </p>
              </header>
              <div className="hidden flex-1 space-y-6 overflow-y-auto p-4 text-gray-400 md:block">
                <article className="space-y-2">
                  <h2 className="text-lg text-gray-200">Introduction</h2>
                  <ul className="list-inside list-disc space-y-2">
                    <li>Open inspector and head to Network tab</li>
                    <li>All client requests are handled through HTTP</li>
                    <li>
                      We have a simple backend subscription on new messages that
                      adds the newly added message to the current state
                    </li>
                  </ul>
                </article>
                {userName && (
                  <article>
                    <h2 className="text-lg text-gray-200">User information</h2>
                    <ul className="space-y-2">
                      <li className="text-lg">
                        You&apos;re{' '}
                        <input
                          id="name"
                          name="name"
                          type="text"
                          disabled
                          className="bg-transparent"
                          value={userName}
                        />
                      </li>
                      <li>
                        <button onClick={() => signOut()}>Sign Out</button>
                      </li>
                    </ul>
                  </article>
                )}
              </div>
            </div>
          </div>
          <div className="hidden h-16 shrink-0 md:block"></div>
        </section>
        <div className="flex-1 overflow-y-hidden md:h-screen">
          <section className="flex h-full flex-col justify-end space-y-4 bg-gray-700 p-4">
            <div className="space-y-4 overflow-y-auto">
              <button
                data-testid="loadMore"
                onClick={() => fetchNextPage()}
                disabled={!hasNextPage || isFetchingNextPage}
                className="rounded bg-indigo-500 px-4 py-2 text-white disabled:opacity-40"
              >
                {isFetchingNextPage
                  ? 'Loading more...'
                  : hasNextPage
                  ? 'Load More'
                  : 'Nothing more to load'}
              </button>
              <div className="space-y-4">
                {messages?.map((item) => (
                  <article key={item.id} className=" text-gray-50">
                    <header className="flex space-x-2 text-sm">
                      <h3 className="text-base">
                        {item.source === 'RAW' ? (
                          item.name
                        ) : (
                          <a
                            href={`https://github.com/${item.name}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {item.name}
                          </a>
                        )}
                      </h3>
                      <span className="text-gray-500">
                        {new Intl.DateTimeFormat('en-GB', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(item.createdAt)}
                      </span>
                    </header>
                    <p className="whitespace-pre-line text-xl leading-tight">
                      {item.text}
                    </p>
                  </article>
                ))}
                <div ref={scrollTargetRef}></div>
              </div>
            </div>
            <div className="w-full">
              <AddMessageForm onMessagePost={() => scrollToBottomOfList()} />
              <p className="h-2 italic text-gray-400">
                {currentlyTyping.length
                  ? `${currentlyTyping.join(', ')} typing...`
                  : ''}
              </p>
            </div>

            {process.env.NODE_ENV !== 'production' && (
              <div className="hidden md:block">
                <ReactQueryDevtools initialIsOpen={false} />
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

/**
 * If you want to statically render this page
 * - Export `appRouter` & `createContext` from [trpc].ts
 * - Make the `opts` object optional on `createContext()`
 *
 * @link https://trpc.io/docs/v11/ssg
 */
// export const getStaticProps = async (
//   context: GetStaticPropsContext<{ filter: string }>,
// ) => {
//   const ssg = createServerSideHelpers({
//     router: appRouter,
//     ctx: await createContext(),
//   });
//
//   await ssg.fetchQuery('post.all');
//
//   return {
//     props: {
//       trpcState: ssg.dehydrate(),
//       filter: context.params?.filter ?? 'all',
//     },
//     revalidate: 1,
//   };
// };