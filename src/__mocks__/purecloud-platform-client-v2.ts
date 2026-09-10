const mockClient = {
  setEnvironment: jest.fn(),
  setAccessToken: jest.fn(),
  loginImplicitGrant: jest.fn()
}

const mockAgentId = 'e02618ce-1ae8-4429-bdb0-2d55f701a545'

const mockGenesys = {
  ApiClient: {
    instance: mockClient
  },
  ConversationsApi: function () {
    return {
      getConversation: jest.fn(
        async (conversationId: string): Promise<object | undefined> => {
          if (conversationId === 'fake-conversation-id') {
            const conversation = {
              participants: [
                {
                  purpose: 'customer',
                  aniName: '1234',
                  calls: [
                    {
                      self: {
                        addressRaw: '123123132@fake-node'
                      }
                    }
                  ]
                },
                {
                  purpose: 'agent',
                  userId: mockAgentId,
                  calls: [
                    {
                      state:
                        (window as any).testParams.genesysInactive === true
                          ? 'disconnected'
                          : 'connected',
                      held: (window as any).testParams.genesysHeld ?? false,
                      muted: (window as any).testParams.genesysMuted ?? false
                    }
                  ]
                }
              ]
            }
            return conversation
          }
          if (conversationId === 'fake-outbound-conversation-id') {
            // Outbound personal call (no callFromQueueId): agent = 'user',
            // dialed far end = 'external'. The dialed URI carries the trunk
            // parameter Genesys appends (probe §7.2).
            return {
              participants: [
                {
                  purpose: 'user',
                  userId: mockAgentId,
                  calls: [{ state: 'connected', held: false, muted: false }]
                },
                {
                  purpose: 'external',
                  aniName: 'RBFCU Genesys',
                  dnis: 'sip:30005@pex-simon-conf1.genesys.pexsupport.com',
                  calls: [
                    {
                      state: 'connected',
                      // The dialed destination is the far end's OWN address.
                      self: {
                        addressRaw:
                          'sip:30005@pex-simon-conf1.genesys.pexsupport.com;language=en-US',
                        addressNormalized:
                          'sip:30005@pex-simon-conf1.genesys.pexsupport.com'
                      },
                      other: {
                        addressRaw:
                          'sip:6a908849d5fe088fb7205f0c+pexip.orgspan.com@localhost'
                      }
                    }
                  ]
                }
              ]
            }
          }
          throw Error('Conversation id not found')
        }
      )
    }
  },
  NotificationsApi: function () {
    return {
      postNotificationsChannels: async (): Promise<void> => {
        await Promise.resolve()
      }
    }
  },
  UsersApi: function () {
    return {
      getUsersMe: jest.fn(() => ({
        id: mockAgentId,
        name: 'John'
      }))
    }
  }
}

export default mockGenesys
