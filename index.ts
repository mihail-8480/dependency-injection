import "reflect-metadata";

export type Constructor<T> = Function & { prototype: T };
export type NonAbstractConstructor<T, TProps extends any[]> = new (
  ...props: TProps
) => T;

export type ServiceConstructor = Constructor<any>;

export type ServiceConstructorResult<T extends ServiceConstructor> =
  T extends Constructor<infer TValue> ? TValue : never;

export type RegisterDisposableCallback = (
  t: IDisposable | IAsyncDisposable
) => void;

export type ServiceConstructorProps<T extends ServiceConstructor> =
  T extends NonAbstractConstructor<any, infer TProps> ? TProps : never;

class DisposableRegistry implements IAsyncDisposable {
  #dispose: (IDisposable | IAsyncDisposable)[] = [];
  register(disposable: IDisposable | IAsyncDisposable) {
    this.#dispose.push(disposable);
  }

  createRegistrationCallback(): RegisterDisposableCallback {
    return this.register.bind(this);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    const oldDispose = this.#dispose;
    this.#dispose = [];
    for (const item of oldDispose) {
      if (Symbol.asyncDispose in item) {
        await item[Symbol.asyncDispose]();
      }
      if (Symbol.dispose in item) {
        item[Symbol.dispose]();
      }
    }
  }
}

export type ServiceFactory<T> = (
  scope: ServiceCollection,
  registerDisposable: RegisterDisposableCallback
) => T;

export type TaggedService<T> =
  | {
      tag: "scoped";
      factory: ServiceFactory<T>;
    }
  | {
      tag: "transient";
      factory: ServiceFactory<T>;
    }
  | {
      tag: "singleton";
      factory: ServiceFactory<T>;
      store: T | undefined;
    };

export interface IAsyncDisposable {
  [Symbol.asyncDispose](): Promise<void>;
}

export interface IDisposable {
  [Symbol.dispose](): void;
}

export function inject<T extends {}, TKey extends string>(
  target: T,
  propertyKey: TKey,
  type?: any
): void {
  const designType =
    type ?? Reflect.getMetadata("design:type", target, propertyKey);
  if (!Reflect.hasMetadata("inject", target)) {
    Reflect.defineMetadata("inject", [[propertyKey, designType]], target);
  } else {
    const metadata = Reflect.getMetadata("inject", target);
    metadata.push([propertyKey, designType]);
  }
}

function getInjectionMetadata<T extends { prototype: object }>(target: T) {
  return (Reflect.getMetadata("inject", target.prototype) ?? []) as [
    string,
    ServiceConstructor
  ][];
}

function getFromTaggedService<T>(
  services: ServiceCollection,
  tagged: TaggedService<T>,
  registerDisposable: RegisterDisposableCallback
): T {
  if (tagged.tag === "transient") {
    return tagged.factory(services, registerDisposable);
  }
  if (tagged.tag === "singleton") {
    if (tagged.store) {
      return tagged.store;
    }
    tagged.store = tagged.factory(services, registerDisposable);
    return tagged.store;
  }
  if (tagged.tag === "scoped") {
    throw new TypeError("Cannot create service outside of scope");
  }

  throw new TypeError("Invalid tag");
}

export abstract class ServiceCollection implements IAsyncDisposable {
  #disposeRegistry = new DisposableRegistry();
  get disposeRegistry() {
    return this.#disposeRegistry;
  }

  inject<T extends ServiceConstructor>(
    service: T,
    ...props: ServiceConstructorProps<T>
  ): ServiceConstructorResult<T> {
    const injectionMetadata = getInjectionMetadata(service);
    const value = new (service as any)(...(props as any));
    for (const [key, injectService] of injectionMetadata) {
      value[key] = this.get(injectService);
    }
    return value;
  }

  get<T extends ServiceConstructor>(
    serviceConstructor: T
  ): ServiceConstructorResult<T> | undefined {
    const tag = this.getTag(serviceConstructor);
    if (!tag) {
      return tag;
    }
    return getFromTaggedService(
      this,
      tag,
      this.#disposeRegistry.createRegistrationCallback()
    );
  }
  abstract getTag<T extends ServiceConstructor>(
    serviceConstructor: T
  ): TaggedService<ServiceConstructorResult<T>> | undefined;

  [Symbol.asyncDispose](): Promise<void> {
    return this.#disposeRegistry[Symbol.asyncDispose]();
  }
}

export type CompatibleService<T extends ServiceConstructor> =
  | ServiceConstructorResult<T>
  | ((services: ServiceCollection) => ServiceConstructorResult<T>)
  | NonAbstractConstructor<ServiceConstructorResult<T>, [ServiceCollection]>
  | ServiceConstructorProps<T>;

export abstract class ServiceContainer extends ServiceCollection {
  createScope(): ServiceCollection {
    return new ServiceScope(this);
  }
  abstract addSingleton<TService extends ServiceConstructor>(
    base: TService,
    service: CompatibleService<TService>
  ): void;

  abstract addScoped<TService extends ServiceConstructor>(
    base: TService,
    service: CompatibleService<TService>
  ): void;

  abstract addTransient<TService extends ServiceConstructor>(
    base: TService,
    service: CompatibleService<TService>
  ): void;
}

class ServiceScope extends ServiceCollection implements IAsyncDisposable {
  #base: ServiceCollection;
  #services: Map<TaggedService<any>, any> = new Map();
  constructor(base: ServiceCollection) {
    super();
    this.#base = base;
  }

  getTag<T extends ServiceConstructor>(
    serviceConstructor: T
  ): TaggedService<ServiceConstructorResult<T>> | undefined {
    return this.#base.getTag(serviceConstructor);
  }

  get<T extends ServiceConstructor>(
    serviceConstructor: T
  ): ServiceConstructorResult<T> | undefined {
    if ((serviceConstructor as Function) === ServiceCollection) {
      return this as ServiceConstructorResult<T>;
    }

    const tagged = this.getTag(serviceConstructor);
    if (!tagged) {
      return this.#base.get(serviceConstructor);
    }
    if (tagged.tag === "scoped") {
      const value = this.#services.get(tagged);
      if (value) {
        return value;
      }
      const newValue = tagged.factory(
        this,
        this.disposeRegistry.createRegistrationCallback()
      );
      this.#services.set(tagged, newValue);
      return newValue;
    }
    return getFromTaggedService(
      this.#base,
      tagged,
      this.#base.disposeRegistry.createRegistrationCallback()
    );
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.disposeRegistry[Symbol.asyncDispose]();
  }
}

export class ServiceHost extends ServiceContainer {
  #services: Map<ServiceConstructor, TaggedService<any>> = new Map();

  static #createServiceFactory<TService extends ServiceConstructor>(
    base: TService,
    service: CompatibleService<TService>
  ): ServiceFactory<ServiceConstructorResult<TService>> {
    const registerIfDisposable = (
      instance: ServiceConstructorResult<TService>,
      callback: RegisterDisposableCallback
    ) => {
      if (Symbol.asyncDispose in instance || Symbol.dispose in instance) {
        callback(instance);
      }
      return instance;
    };

    if (typeof service === "function") {
      return (collection, cb) => {
        const anyService = service as any;
        try {
          return registerIfDisposable(
            collection.inject(anyService, collection) as any,
            cb
          );
        } catch {
          return registerIfDisposable(anyService(collection), cb);
        }
      };
    }

    if (Array.isArray(service)) {
      return (collection, cb) =>
        registerIfDisposable(collection.inject(base, ...service), cb);
    }

    return (_, cb) => registerIfDisposable(service as any, cb);
  }
  addSingleton<TService extends ServiceConstructor>(
    base: TService,
    service: CompatibleService<TService>
  ): void {
    this.#services.set(base, {
      tag: "singleton",
      factory: ServiceHost.#createServiceFactory(base, service),
      store: undefined,
    });
  }
  addScoped<TService extends ServiceConstructor>(
    base: TService,
    service: CompatibleService<TService>
  ): void {
    this.#services.set(base, {
      tag: "scoped",
      factory: ServiceHost.#createServiceFactory(base, service),
    });
  }
  addTransient<TService extends ServiceConstructor>(
    base: TService,
    service: CompatibleService<TService>
  ): void {
    this.#services.set(base, {
      tag: "transient",
      factory: ServiceHost.#createServiceFactory(base, service),
    });
  }

  getTag<T extends ServiceConstructor>(
    serviceConstructor: T
  ): TaggedService<ServiceConstructorResult<T>> | undefined {
    return this.#services.get(serviceConstructor);
  }
  override get<T extends ServiceConstructor>(
    serviceConstructor: T
  ): ServiceConstructorResult<T> | undefined {
    if ((serviceConstructor as Function) === ServiceCollection) {
      return this as ServiceConstructorResult<T>;
    }

    if ((serviceConstructor as Function) === ServiceHost) {
      return this as ServiceConstructorResult<T>;
    }

    if ((serviceConstructor as Function) === ServiceContainer) {
      return this as ServiceConstructorResult<T>;
    }

    return super.get(serviceConstructor);
  }
}
